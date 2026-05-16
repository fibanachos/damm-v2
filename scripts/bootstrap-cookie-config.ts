/**
 * One-shot bootstrap on a live cluster:
 * 1) create_operator_account (admin signs) — all operator bits enabled
 * 2) create_config (operator signs) — public pools (pool_creator_authority = default)
 *
 * ENV:
 *   COOKIE_RPC   default https://rpc.cookiescan.io
 *   ADMIN_KEYPAIR required — path to signer that is BOTH in-program admin + operator whitelist (same key)
 *   CONFIG_INDEX default 0
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
  encodeFeeTimeSchedulerParams,
} from "../tests/helpers/feeCodec";

const RPC = process.env.COOKIE_RPC ?? "https://rpc.cookiescan.io";
const CONFIG_INDEX_RAW = process.env.CONFIG_INDEX ?? "0";
const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR;

const ALL_OPERATOR_PERMISSIONS = new BN((1 << 12) - 1); // bits 0..11

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

async function main() {
  if (!ADMIN_KEYPAIR) {
    console.error(
      "ADMIN_KEYPAIR is required (path to admin keypair JSON matching programs/cp-amm ADMINS)."
    );
    process.exitCode = 1;
    return;
  }

  const index = new BN(CONFIG_INDEX_RAW, 10);

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

  const whitelist = wallet.publicKey;
  const operatorPda = deriveOperator(whitelist);
  const configPda = deriveConfig(index);

  console.log(`RPC: ${RPC}`);
  console.log(`Program: ${CP_AMM_PROGRAM_ID.toBase58()}`);
  console.log(`Admin/operator pubkey: ${whitelist.toBase58()}`);
  console.log(`Operator PDA: ${operatorPda.toBase58()}`);
  console.log(`Config PDA [index=${index.toString()}]: ${configPda.toBase58()}`);

  const opInfo = await connection.getAccountInfo(operatorPda);
  if (!opInfo) {
    console.log("\nSending create_operator_account…");
    const sig = await program.methods
      .createOperatorAccount(ALL_OPERATOR_PERMISSIONS)
      .accountsPartial({
        operator: operatorPda,
        whitelistedAddress: whitelist,
        signer: whitelist,
        payer: whitelist,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`✓ create_operator_account: ${sig}`);
  } else {
    console.log("\n.Operator PDA exists — skip create_operator_account");
  }

  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) {
    const cliffFeeNumerator = 2_500_000;
    const baseFeeBlob = encodeFeeTimeSchedulerParams(
      BigInt(cliffFeeNumerator),
      0,
      BigInt(0),
      BigInt(0),
      BaseFeeMode.FeeTimeSchedulerLinear
    );

    console.log("\nSending create_config (public pools)…");

    const sig = await program.methods
      .createConfig(index, {
        poolFees: {
          baseFee: { data: Array.from(baseFeeBlob) },
          compoundingFeeBps: 0,
          padding: 0,
          dynamicFee: null,
        },
        sqrtMinPrice: MIN_SQRT_PRICE,
        sqrtMaxPrice: MAX_SQRT_PRICE,
        vaultConfigKey: PublicKey.default,
        poolCreatorAuthority: PublicKey.default,
        activationType: 0,
        collectFeeMode: 0,
      })
      .accountsPartial({
        config: configPda,
        operator: operatorPda,
        payer: whitelist,
        signer: whitelist,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`✓ create_config: ${sig}`);
  } else {
    console.log("\n.Config PDA exists — skip create_config");
  }

  console.log(`
Done.
Integrators: call initialize_pool with config = ${configPda.toBase58()} .
`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
