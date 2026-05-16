/**
 * Create DAMM v2 static/dynamic configs for Dynamic Bonding Curve migration on Cookie Chain.
 *
 * Uses Cookieora fixed fee tiers (0.25% / 0.3% / 1% / 2% / 4%) mapped to DBC
 * migration_fee_option 0..4, plus one dynamic config for migration_fee_option 6.
 *
 * Each config sets pool_creator_authority to the DBC pool-authority PDA so only DBC
 * can initialize migrated pools against it.
 *
 * ENV:
 *   COOKIE_RPC            default https://rpc.cookiescan.io
 *   ADMIN_KEYPAIR         required — cp-amm admin + operator whitelist key
 *   DBC_PROGRAM_ID        default DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf
 *   DBC_POOL_AUTHORITY    optional override (else derived from DBC_PROGRAM_ID)
 *   START_INDEX           optional first index to try (default: max(existing)+1)
 *
 * Flags:
 *   --dry-run             print plan only
 *
 * Run:
 *   ADMIN_KEYPAIR=keys/local/upgrade-authority-live.json npm run bootstrap:dbc-migration-configs
 *   ADMIN_KEYPAIR=… npm run bootstrap:dbc-migration-configs -- --dry-run
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
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

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
const DBC_PROGRAM_ID = new PublicKey(
  process.env.DBC_PROGRAM_ID ??
    "DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf"
);
const DRY_RUN = process.argv.includes("--dry-run");
const START_INDEX_RAW = process.env.START_INDEX;

/** Cookieora FEE_TIER_PRESETS — src/solana/customizablePoolFees.ts */
const STATIC_MIGRATION_TIERS = [
  {
    migrationFeeOption: 0,
    label: "0.25%",
    bps: 25,
    cliffFeeNumerator: 2_500_000,
  },
  {
    migrationFeeOption: 1,
    label: "0.3%",
    bps: 30,
    cliffFeeNumerator: 3_000_000,
  },
  {
    migrationFeeOption: 2,
    label: "1%",
    bps: 100,
    cliffFeeNumerator: 10_000_000,
  },
  {
    migrationFeeOption: 3,
    label: "2%",
    bps: 200,
    cliffFeeNumerator: 20_000_000,
  },
  {
    migrationFeeOption: 4,
    label: "4%",
    bps: 400,
    cliffFeeNumerator: 40_000_000,
  },
] as const;

const ACTIVATION_TYPE_TIMESTAMP = 1;
const COLLECT_FEE_MODE_QUOTE = 0;
const ALL_OPERATOR_PERMISSIONS = new BN((1 << 12) - 1);

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
    };
  };
};

function derivePoolAuthority(dbcProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    dbcProgramId
  )[0];
}

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

function cliffNumeratorFromConfig(account: ConfigAccount["account"]): number | null {
  try {
    const data = Buffer.from(account.poolFees.baseFee.data);
    const scheduler = decodePodAlignedFeeTimeScheduler(data);
    return scheduler.cliffFeeNumerator.toNumber();
  } catch {
    return null;
  }
}

async function fetchExistingDbcConfigs(
  program: Program<Idl>,
  poolAuthority: PublicKey
): Promise<ConfigAccount[]> {
  const all = (await program.account.config.all()) as ConfigAccount[];
  return all
    .filter((row) => row.account.poolCreatorAuthority.equals(poolAuthority))
    .sort((a, b) => a.account.index.cmp(b.account.index));
}

const CONFIG_INDEX_BATCH_SIZE = 100;

async function findNextFreeConfigIndex(
  connection: Connection,
  used: Set<number>,
  startIndex: number
): Promise<{ index: number; occupied: Set<number> }> {
  const occupied = new Set<number>();
  let index = startIndex;
  while (used.has(index)) index += 1;

  while (true) {
    const batchStart = index;
    const pdas = Array.from({ length: CONFIG_INDEX_BATCH_SIZE }, (_, offset) =>
      deriveConfig(new BN(batchStart + offset))
    );
    const infos = await connection.getMultipleAccountsInfo(pdas);

    for (let offset = 0; offset < infos.length; offset += 1) {
      const candidate = batchStart + offset;
      if (used.has(candidate)) continue;
      if (!infos[offset]) {
        return { index: candidate, occupied };
      }
      occupied.add(candidate);
      used.add(candidate);
    }

    index = batchStart + CONFIG_INDEX_BATCH_SIZE;
  }
}

function formatOccupiedIndexes(indexes: Set<number>): string {
  const sorted = [...indexes].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  if (sorted.length <= 16) return sorted.join(", ");

  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
      continue;
    }
    ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
    rangeStart = sorted[i];
    rangeEnd = sorted[i];
  }
  ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
  return `${ranges.join(", ")} (${sorted.length} occupied)`;
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
  const poolAuthority = process.env.DBC_POOL_AUTHORITY
    ? new PublicKey(process.env.DBC_POOL_AUTHORITY)
    : derivePoolAuthority(DBC_PROGRAM_ID);

  const connection = new Connection(RPC, "confirmed");
  const wallet = new Wallet(adminKp);
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  setProvider(provider);

  const idl = { ...(idlRaw as Idl), address: CP_AMM_PROGRAM_ID.toBase58() };
  const program = new Program(idl as Idl, provider);

  const operatorPda = deriveOperator(wallet.publicKey);

  console.log(`RPC:                 ${RPC}`);
  console.log(`Mode:                ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`DAMM v2 program:     ${CP_AMM_PROGRAM_ID.toBase58()}`);
  console.log(`Admin/operator:      ${wallet.publicKey.toBase58()}`);
  console.log(`DBC program:         ${DBC_PROGRAM_ID.toBase58()}`);
  console.log(`DBC pool authority:  ${poolAuthority.toBase58()}`);
  console.log("");

  await ensureOperator(program, connection, operatorPda, wallet.publicKey);

  const existing = await fetchExistingDbcConfigs(program, poolAuthority);
  const maxExistingIndex = existing.reduce(
    (max, row) => Math.max(max, row.account.index.toNumber()),
    -1
  );
  const scanFrom =
    START_INDEX_RAW != null ? Number(START_INDEX_RAW) : Math.max(maxExistingIndex + 1, 0);
  const usedIndexes = new Set(
    existing.map((row) => row.account.index.toNumber())
  );
  const { index: nextIndex, occupied: occupiedIndexes } =
    await findNextFreeConfigIndex(connection, usedIndexes, scanFrom);

  console.log(
    `Existing DBC migration configs: ${existing.length}${
      existing.length ? ` (max index ${maxExistingIndex})` : ""
    }`
  );
  if (occupiedIndexes.size > 0) {
    console.log(
      `Occupied config indexes from ${scanFrom}: ${formatOccupiedIndexes(occupiedIndexes)}`
    );
  }
  console.log(`Next free index: ${nextIndex}`);
  console.log("");

  let nextIndexCursor = nextIndex;

  const created: Array<{
    migrationFeeOption: number;
    label: string;
    index: number;
    config: string;
  }> = [];

  for (const tier of STATIC_MIGRATION_TIERS) {
    const match = existing.find((row) => {
      if (row.account.configType !== 0) return false;
      if (row.account.activationType !== ACTIVATION_TYPE_TIMESTAMP) return false;
      if (row.account.collectFeeMode !== COLLECT_FEE_MODE_QUOTE) return false;
      return cliffNumeratorFromConfig(row.account) === tier.cliffFeeNumerator;
    });

    if (match) {
      console.log(
        `✓ migration_fee_option ${tier.migrationFeeOption} (${tier.label}) already exists: ${match.publicKey.toBase58()} [index ${match.account.index.toString()}]`
      );
      created.push({
        migrationFeeOption: tier.migrationFeeOption,
        label: tier.label,
        index: match.account.index.toNumber(),
        config: match.publicKey.toBase58(),
      });
      continue;
    }

    const index = (
      await findNextFreeConfigIndex(connection, usedIndexes, nextIndexCursor)
    ).index;
    usedIndexes.add(index);
    nextIndexCursor = index + 1;
    const configPda = deriveConfig(new BN(index));
    const baseFeeBlob = encodeFeeTimeSchedulerParams(
      BigInt(tier.cliffFeeNumerator),
      0,
      BigInt(0),
      BigInt(0),
      BaseFeeMode.FeeTimeSchedulerLinear
    );

    console.log(
      `${DRY_RUN ? "Would create" : "Creating"} migration_fee_option ${tier.migrationFeeOption} (${tier.label}) → index ${index} → ${configPda.toBase58()}`
    );

    if (!DRY_RUN) {
      const sig = await program.methods
        .createConfig(new BN(index), {
          poolFees: {
            baseFee: { data: Array.from(baseFeeBlob) },
            compoundingFeeBps: 0,
            padding: 0,
            dynamicFee: null,
          },
          sqrtMinPrice: MIN_SQRT_PRICE,
          sqrtMaxPrice: MAX_SQRT_PRICE,
          vaultConfigKey: PublicKey.default,
          poolCreatorAuthority: poolAuthority,
          activationType: ACTIVATION_TYPE_TIMESTAMP,
          collectFeeMode: COLLECT_FEE_MODE_QUOTE,
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

    created.push({
      migrationFeeOption: tier.migrationFeeOption,
      label: tier.label,
      index,
      config: configPda.toBase58(),
    });
  }

  const dynamicMatch = existing.find((row) => row.account.configType === 1);
  if (dynamicMatch) {
    console.log(
      `\n✓ migration_fee_option 6 (Customizable) already exists: ${dynamicMatch.publicKey.toBase58()} [index ${dynamicMatch.account.index.toString()}]`
    );
    created.push({
      migrationFeeOption: 6,
      label: "Customizable",
      index: dynamicMatch.account.index.toNumber(),
      config: dynamicMatch.publicKey.toBase58(),
    });
  } else {
    const index = (
      await findNextFreeConfigIndex(connection, usedIndexes, nextIndexCursor)
    ).index;
    usedIndexes.add(index);
    nextIndexCursor = index + 1;
    const configPda = deriveConfig(new BN(index));
    console.log(
      `\n${DRY_RUN ? "Would create" : "Creating"} migration_fee_option 6 (Customizable dynamic config) → index ${index} → ${configPda.toBase58()}`
    );

    if (!DRY_RUN) {
      const sig = await program.methods
        .createDynamicConfig(new BN(index), {
          poolCreatorAuthority: poolAuthority,
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

    created.push({
      migrationFeeOption: 6,
      label: "Customizable",
      index,
      config: configPda.toBase58(),
    });
  }

  console.log("\n--- DBC migration_fee_option → DAMM v2 config ---");
  for (const row of created.sort(
    (a, b) => a.migrationFeeOption - b.migrationFeeOption
  )) {
    console.log(
      `migration_fee_option == ${row.migrationFeeOption} (${row.label}): ${row.config}  [index ${row.index}]`
    );
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
