/**
 * Create the DAMM v2 static config for MomoSwap launchpad graduations on Cookie Chain
 * (anchor-launchpad-momoswap MIGRATION.md §3, option C).
 *
 * One config, one fee policy — the launch/marketing-phase venue decision:
 *   - flat 1% base fee (cliff_fee_numerator 10_000_000), no decay
 *   - dynamic (volatility) fee at the stock 20%-of-base cap → 1.0–1.2% total
 *   - collect_fee_mode = OnlyB → all fees accrue in wCOOK
 *   - compounding_fee_bps = 0 → fees claimable, never auto-compounded
 *   - full range, no alpha vault, activation = Timestamp (pool live at creation)
 *   - pool_creator_authority = the MomoSwap migration authority, so ONLY the
 *     graduation keeper can create pools against this config (anti-squatting)
 *
 * Fee split downstream (not part of this config): cp-amm's hardcoded 20% protocol fee
 * → Cookiebox; the remaining 80% pro-rata over two permanently-locked positions
 * (creator 62.5% of liquidity = 50% of every fee, MomoSwap 37.5% = 30%).
 *
 * Idempotent: if a static config with this exact shape already exists for the
 * migration authority, it is reported and nothing is created.
 *
 * ENV:
 *   COOKIE_RPC                     default https://rpc.cookiescan.io
 *   ADMIN_KEYPAIR                  required — cp-amm admin + operator whitelist key
 *   MOMOSWAP_MIGRATION_AUTHORITY   default 9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni
 *   START_INDEX                    optional first index to try (default: scan from 0)
 *
 * Flags:
 *   --dry-run                      print plan only
 *
 * Run:
 *   ADMIN_KEYPAIR=keys/local/upgrade-authority-live.json npm run bootstrap:momoswap-migration-config -- --dry-run
 *   ADMIN_KEYPAIR=keys/local/upgrade-authority-live.json npm run bootstrap:momoswap-migration-config
 */

import fs from "fs";

import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  setProvider,
  type Idl,
} from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import idlRaw from "../target/idl/cp_amm.json";
import {
  CP_AMM_PROGRAM_ID,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
} from "../tests/helpers/constants";
import {
  BaseFeeMode,
  decodePodAlignedFeeTimeScheduler,
  encodeFeeTimeSchedulerParams,
} from "../tests/helpers/feeCodec";

const RPC = process.env.COOKIE_RPC ?? "https://rpc.cookiescan.io";
const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR;
const MIGRATION_AUTHORITY = new PublicKey(
  process.env.MOMOSWAP_MIGRATION_AUTHORITY ??
    "9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni"
);
const DRY_RUN = process.argv.includes("--dry-run");
const START_INDEX_RAW = process.env.START_INDEX;

/** Flat 1% forever: numerator of 1e9 (MIGRATION.md §3 — the landed creator-first economics). */
const CLIFF_FEE_NUMERATOR = 10_000_000;

const ACTIVATION_TYPE_TIMESTAMP = 1;
/** cp-amm `CollectFeeMode`: BothToken = 0, OnlyB = 1. Token B is wCOOK at graduation. */
const COLLECT_FEE_MODE_ONLY_B = 1;
const ALL_OPERATOR_PERMISSIONS = new BN((1 << 12) - 1);

/**
 * Stock getDynamicFeeParams(10_000_000) output — volatility fee capped at 20% of the 1%
 * base (max +0.2%), sized for a 15% max price move; same values as the on-chain DBC
 * 1%-tier configs. Re-derive via tests/helpers getDynamicFeeParams if the base ever changes.
 */
const DYNAMIC_FEE_PARAMS = {
  binStep: 1,
  binStepU128: new BN("1844674407370955"),
  filterPeriod: 10,
  decayPeriod: 120,
  reductionFactor: 5000,
  maxVolatilityAccumulator: 14_460_000,
  variableFeeControl: 956,
};

type ConfigAccount = {
  publicKey: PublicKey;
  account: {
    index: BN;
    configType: number;
    poolCreatorAuthority: PublicKey;
    activationType: number;
    collectFeeMode: number;
    poolFees: {
      baseFee: { data: number[] };
      dynamicFee?: { initialized: number };
    };
  };
};

function deriveOperator(whitelist: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), whitelist.toBuffer()],
    CP_AMM_PROGRAM_ID
  )[0];
}

function deriveConfig(index: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), index.toArrayLike(Buffer, "le", 8)],
    CP_AMM_PROGRAM_ID
  )[0];
}

function cliffNumeratorFromConfig(
  account: ConfigAccount["account"]
): number | null {
  try {
    const data = Buffer.from(account.poolFees.baseFee.data);
    const scheduler = decodePodAlignedFeeTimeScheduler(data);
    return scheduler.cliffFeeNumerator.toNumber();
  } catch {
    return null;
  }
}

const CONFIG_INDEX_BATCH_SIZE = 100;

async function findNextFreeConfigIndex(
  connection: Connection,
  startIndex: number
): Promise<number> {
  let index = startIndex;
  while (true) {
    const batchStart = index;
    const pdas = Array.from({ length: CONFIG_INDEX_BATCH_SIZE }, (_, offset) =>
      deriveConfig(new BN(batchStart + offset))
    );
    const infos = await connection.getMultipleAccountsInfo(pdas);
    for (let offset = 0; offset < infos.length; offset += 1) {
      if (!infos[offset]) return batchStart + offset;
    }
    index = batchStart + CONFIG_INDEX_BATCH_SIZE;
  }
}

async function ensureOperator(
  program: Program<Idl>,
  connection: Connection,
  operatorPda: PublicKey,
  admin: PublicKey
) {
  const opInfo = await connection.getAccountInfo(operatorPda);
  if (opInfo) {
    console.log(`Operator exists: ${operatorPda.toBase58()}`);
    return;
  }
  if (DRY_RUN) {
    console.log(`Would create operator: ${operatorPda.toBase58()}`);
    return;
  }
  const sig = await program.methods
    .createOperatorAccount(ALL_OPERATOR_PERMISSIONS)
    .accountsPartial({
      operator: operatorPda,
      whitelistedAddress: admin,
      signer: admin,
      payer: admin,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`✓ create_operator_account: ${sig}`);
}

async function main() {
  if (!ADMIN_KEYPAIR) {
    console.error("ADMIN_KEYPAIR is required.");
    process.exitCode = 1;
    return;
  }

  const adminSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(ADMIN_KEYPAIR, "utf-8"))
  );
  const adminKp = Keypair.fromSecretKey(adminSecret);

  const connection = new Connection(RPC, "confirmed");
  const wallet = new Wallet(adminKp);
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  setProvider(provider);

  const idl = { ...(idlRaw as Idl), address: CP_AMM_PROGRAM_ID.toBase58() };
  const program = new Program(idl as Idl, provider);

  const operatorPda = deriveOperator(wallet.publicKey);

  console.log(`RPC:                  ${RPC}`);
  console.log(`Mode:                 ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`DAMM v2 program:      ${CP_AMM_PROGRAM_ID.toBase58()}`);
  console.log(`Admin/operator:       ${wallet.publicKey.toBase58()}`);
  console.log(`Migration authority:  ${MIGRATION_AUTHORITY.toBase58()}`);
  console.log("");

  await ensureOperator(program, connection, operatorPda, wallet.publicKey);

  // idempotency: an existing static config with this exact shape for this authority
  const all = (await program.account.config.all()) as ConfigAccount[];
  const match = all.find((row) => {
    if (!row.account.poolCreatorAuthority.equals(MIGRATION_AUTHORITY))
      return false;
    if (row.account.configType !== 0) return false;
    if (row.account.activationType !== ACTIVATION_TYPE_TIMESTAMP) return false;
    if (row.account.collectFeeMode !== COLLECT_FEE_MODE_ONLY_B) return false;
    if (row.account.poolFees.dynamicFee?.initialized !== 1) return false;
    return cliffNumeratorFromConfig(row.account) === CLIFF_FEE_NUMERATOR;
  });

  if (match) {
    console.log(
      `✓ MomoSwap migration config already exists: ${match.publicKey.toBase58()} [index ${match.account.index.toString()}]`
    );
    console.log(`\nDAMM_CONFIG=${match.publicKey.toBase58()}`);
    return;
  }

  const scanFrom = START_INDEX_RAW != null ? Number(START_INDEX_RAW) : 0;
  const index = await findNextFreeConfigIndex(connection, scanFrom);
  const configPda = deriveConfig(new BN(index));
  const baseFeeBlob = encodeFeeTimeSchedulerParams(
    BigInt(CLIFF_FEE_NUMERATOR),
    0,
    BigInt(0),
    BigInt(0),
    BaseFeeMode.FeeTimeSchedulerLinear
  );

  console.log(
    `${
      DRY_RUN ? "Would create" : "Creating"
    } MomoSwap migration config (1% base + dynamic, OnlyB) → index ${index} → ${configPda.toBase58()}`
  );

  if (!DRY_RUN) {
    const sig = await program.methods
      .createConfig(new BN(index), {
        poolFees: {
          baseFee: { data: Array.from(baseFeeBlob) },
          compoundingFeeBps: 0,
          padding: 0,
          dynamicFee: DYNAMIC_FEE_PARAMS,
        },
        sqrtMinPrice: MIN_SQRT_PRICE,
        sqrtMaxPrice: MAX_SQRT_PRICE,
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: MIGRATION_AUTHORITY,
        activationType: ACTIVATION_TYPE_TIMESTAMP,
        collectFeeMode: COLLECT_FEE_MODE_ONLY_B,
      })
      .accountsPartial({
        config: configPda,
        operator: operatorPda,
        payer: wallet.publicKey,
        signer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${sig}`);
  }

  console.log(
    `\n${
      DRY_RUN ? "Planned" : "Done"
    }. Pin this for the graduation script + backend:`
  );
  console.log(`DAMM_CONFIG=${configPda.toBase58()}  [index ${index}]`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
