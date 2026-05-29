/**
 * Fetch all on-chain cp-amm Config accounts and validate layout + fee params
 * against the current program IDL (post-upgrade sanity check).
 *
 * ENV:
 *   COOKIE_RPC  default https://rpc.cookiescan.io
 *
 * Run:
 *   npm run validate:configs
 */

import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import idlRaw from "../target/idl/cp_amm.json";
import { CpAmm } from "../target/types/cp_amm";
import {
  BASIS_POINT_MAX,
  BIN_STEP_BPS_DEFAULT,
  BIN_STEP_BPS_U128_DEFAULT,
  CP_AMM_PROGRAM_ID,
  FEE_DENOMINATOR,
  MAX_FEE_BPS,
  MAX_FEE_NUMERATOR,
  MAX_RATE_LIMITER_DURATION_IN_SECONDS,
  MAX_RATE_LIMITER_DURATION_IN_SLOTS,
  MAX_SQRT_PRICE,
  MIN_FEE_NUMERATOR,
  MIN_SQRT_PRICE,
} from "../tests/helpers/constants";
import {
  BaseFeeMode,
  decodePodAlignedFeeMarketCapScheduler,
  decodePodAlignedFeeRateLimiter,
  decodePodAlignedFeeTimeScheduler,
} from "../tests/helpers/feeCodec";

const RPC = process.env.COOKIE_RPC ?? "https://rpc.cookiescan.io";
const ONE_Q64 = 1n << 64n;
const MAX_BASIS_POINT = 10_000n;
const U24_MAX = (1 << 24) - 1;

enum CollectFeeMode {
  BothToken = 0,
  OnlyB = 1,
  Compounding = 2,
}

enum ActivationType {
  Slot = 0,
  Timestamp = 1,
}

enum ConfigType {
  Static = 0,
  Dynamic = 1,
}

type ConfigRow = {
  publicKey: PublicKey;
  account: Awaited<
    ReturnType<Program<CpAmm>["account"]["config"]["all"]>
  >[number]["account"];
};

type Issue = { code: string; detail: string };

function validateFeeFraction(numerator: number, denominator: number): string | null {
  if (denominator === 0 || numerator >= denominator) {
    return `invalid fee fraction ${numerator}/${denominator}`;
  }
  return null;
}

function getFeeInPeriod(
  cliffFeeNumerator: number,
  reductionFactor: number,
  passedPeriod: number
): number | null {
  if (reductionFactor === 0) return cliffFeeNumerator;
  const bps = (BigInt(reductionFactor) << 64n) / MAX_BASIS_POINT;
  const base = ONE_Q64 - bps;
  const result = powQ64(base, passedPeriod);
  if (result === null) return null;
  const fee = Number((result * BigInt(cliffFeeNumerator)) >> 64n);
  return fee;
}

function powQ64(base: bigint, exp: number): bigint | null {
  if (exp === 0) return ONE_Q64;
  if (exp >= 0x80000) return null;

  let squaredBase = base;
  let result = ONE_Q64;
  let invert = false;

  if (squaredBase >= result) {
    squaredBase = (2n ** 128n - 1n) / squaredBase;
    invert = true;
  }

  const run = (bit: number) => {
    if (exp & bit) {
      result = (result * squaredBase) >> 64n;
    }
    squaredBase = (squaredBase * squaredBase) >> 64n;
  };

  run(0x1);
  run(0x2);
  run(0x4);
  run(0x8);
  run(0x10);
  run(0x20);
  run(0x40);
  run(0x80);
  run(0x100);
  run(0x200);
  run(0x400);
  run(0x800);
  run(0x1000);
  run(0x2000);
  run(0x4000);
  run(0x8000);
  run(0x10000);
  run(0x20000);
  run(0x40000);

  if (result === 0n) return null;
  return invert ? (2n ** 128n - 1n) / result : result;
}

function minTimeSchedulerFee(
  scheduler: ReturnType<typeof decodePodAlignedFeeTimeScheduler>
): number | null {
  const period = scheduler.numberOfPeriod;
  const mode = scheduler.baseFeeMode as BaseFeeMode;

  if (mode === BaseFeeMode.FeeTimeSchedulerLinear) {
    const fee =
      scheduler.cliffFeeNumerator.toNumber() -
      scheduler.reductionFactor.toNumber() * period;
    return fee;
  }
  if (mode === BaseFeeMode.FeeTimeSchedulerExponential) {
    return getFeeInPeriod(
      scheduler.cliffFeeNumerator.toNumber(),
      scheduler.reductionFactor.toNumber(),
      period
    );
  }
  return null;
}

function validateTimeScheduler(data: Buffer): Issue[] {
  const issues: Issue[] = [];
  let scheduler: ReturnType<typeof decodePodAlignedFeeTimeScheduler>;
  try {
    scheduler = decodePodAlignedFeeTimeScheduler(data);
  } catch (e) {
    return [{ code: "decode_base_fee", detail: String(e) }];
  }

  const pf = scheduler.periodFrequency.toNumber();
  const np = scheduler.numberOfPeriod;
  const rf = scheduler.reductionFactor.toNumber();

  if (pf !== 0 || np !== 0 || rf !== 0) {
    if (np === 0 || pf === 0 || rf === 0) {
      issues.push({
        code: "invalid_fee_time_scheduler",
        detail: "partial scheduler params (need all non-zero or all zero)",
      });
    }
  }

  const minFee = minTimeSchedulerFee(scheduler);
  const maxFee = scheduler.cliffFeeNumerator.toNumber();
  if (minFee === null) {
    issues.push({ code: "unknown_base_fee_mode", detail: String(scheduler.baseFeeMode) });
    return issues;
  }

  for (const [label, fee] of [
    ["min", minFee],
    ["max", maxFee],
  ] as const) {
    const frac = validateFeeFraction(fee, FEE_DENOMINATOR);
    if (frac) {
      issues.push({ code: "invalid_fee_fraction", detail: `${label}: ${frac}` });
    }
  }

  if (minFee < MIN_FEE_NUMERATOR || maxFee > MAX_FEE_NUMERATOR) {
    issues.push({
      code: "exceed_max_fee_bps",
      detail: `min=${minFee} max=${maxFee} allowed=[${MIN_FEE_NUMERATOR},${MAX_FEE_NUMERATOR}]`,
    });
  }

  return issues;
}

function validateMarketCapScheduler(data: Buffer): Issue[] {
  const issues: Issue[] = [];
  let scheduler: ReturnType<typeof decodePodAlignedFeeMarketCapScheduler>;
  try {
    scheduler = decodePodAlignedFeeMarketCapScheduler(data);
  } catch (e) {
    return [{ code: "decode_base_fee", detail: String(e) }];
  }

  if (scheduler.reductionFactor.toNumber() === 0) {
    issues.push({ code: "invalid_fee_market_cap_scheduler", detail: "reduction_factor=0" });
  }
  if (scheduler.sqrtPriceStepBps === 0) {
    issues.push({ code: "invalid_fee_market_cap_scheduler", detail: "sqrt_price_step_bps=0" });
  }
  if (scheduler.schedulerExpirationDuration === 0) {
    issues.push({
      code: "invalid_fee_market_cap_scheduler",
      detail: "scheduler_expiration_duration=0",
    });
  }
  if (scheduler.numberOfPeriod === 0) {
    issues.push({ code: "invalid_fee_market_cap_scheduler", detail: "number_of_period=0" });
  }

  const maxFee = scheduler.cliffFeeNumerator.toNumber();
  const minFee =
    scheduler.baseFeeMode === BaseFeeMode.FeeMarketCapSchedulerLinear
      ? maxFee - scheduler.reductionFactor.toNumber() * scheduler.numberOfPeriod
      : getFeeInPeriod(
          maxFee,
          scheduler.reductionFactor.toNumber(),
          scheduler.numberOfPeriod
        );

  if (minFee === null) {
    issues.push({ code: "invalid_fee_market_cap_scheduler", detail: "failed min fee calc" });
    return issues;
  }

  for (const [label, fee] of [
    ["min", minFee],
    ["max", maxFee],
  ] as const) {
    const frac = validateFeeFraction(fee, FEE_DENOMINATOR);
    if (frac) {
      issues.push({ code: "invalid_fee_fraction", detail: `${label}: ${frac}` });
    }
  }

  if (minFee < MIN_FEE_NUMERATOR || maxFee > MAX_FEE_NUMERATOR) {
    issues.push({
      code: "exceed_max_fee_bps",
      detail: `min=${minFee} max=${maxFee}`,
    });
  }

  return issues;
}

function validateRateLimiter(
  data: Buffer,
  collectFeeMode: CollectFeeMode,
  activationType: ActivationType
): Issue[] {
  const issues: Issue[] = [];
  let limiter: ReturnType<typeof decodePodAlignedFeeRateLimiter>;
  try {
    limiter = decodePodAlignedFeeRateLimiter(data);
  } catch (e) {
    return [{ code: "decode_base_fee", detail: String(e) }];
  }

  if (collectFeeMode !== CollectFeeMode.OnlyB) {
    issues.push({
      code: "invalid_fee_rate_limiter",
      detail: `rate limiter requires collect_fee_mode=OnlyB, got ${collectFeeMode}`,
    });
  }

  const maxFeeFromBps = Math.floor(
    (limiter.maxFeeBps * FEE_DENOMINATOR) / BASIS_POINT_MAX
  );
  const cliff = limiter.cliffFeeNumerator.toNumber();

  if (cliff < MIN_FEE_NUMERATOR || cliff > maxFeeFromBps) {
    issues.push({
      code: "invalid_fee_rate_limiter",
      detail: `cliff=${cliff} not in [${MIN_FEE_NUMERATOR},${maxFeeFromBps}]`,
    });
  }

  const zeroLimiter =
    limiter.feeIncrementBps === 0 &&
    limiter.maxLimiterDuration === 0 &&
    limiter.referenceAmount.isZero();

  if (!zeroLimiter) {
    const maxDuration =
      activationType === ActivationType.Slot
        ? MAX_RATE_LIMITER_DURATION_IN_SLOTS
        : MAX_RATE_LIMITER_DURATION_IN_SECONDS;
    if (limiter.maxLimiterDuration > maxDuration) {
      issues.push({
        code: "invalid_fee_rate_limiter",
        detail: `max_limiter_duration=${limiter.maxLimiterDuration} > ${maxDuration}`,
      });
    }

    const feeIncrementNumerator = Math.floor(
      (limiter.feeIncrementBps * FEE_DENOMINATOR) / BASIS_POINT_MAX
    );
    if (feeIncrementNumerator >= FEE_DENOMINATOR) {
      issues.push({
        code: "invalid_fee_rate_limiter",
        detail: "fee_increment_numerator >= FEE_DENOMINATOR",
      });
    }

    if (limiter.maxFeeBps > MAX_FEE_BPS) {
      issues.push({
        code: "invalid_fee_rate_limiter",
        detail: `max_fee_bps=${limiter.maxFeeBps} > ${MAX_FEE_BPS}`,
      });
    }
  }

  return issues;
}

function validateDynamicFee(
  dynamicFee: ConfigRow["account"]["poolFees"]["dynamicFee"]
): Issue[] {
  if (dynamicFee.initialized !== 1) return [];

  const issues: Issue[] = [];
  if (dynamicFee.binStep !== BIN_STEP_BPS_DEFAULT) {
    issues.push({ code: "invalid_dynamic_fee", detail: `bin_step=${dynamicFee.binStep}` });
  }
  if (!dynamicFee.binStepU128.eq(BIN_STEP_BPS_U128_DEFAULT)) {
    issues.push({
      code: "invalid_dynamic_fee",
      detail: `bin_step_u128=${dynamicFee.binStepU128.toString()}`,
    });
  }
  if (dynamicFee.filterPeriod >= dynamicFee.decayPeriod) {
    issues.push({
      code: "invalid_dynamic_fee",
      detail: "filter_period >= decay_period",
    });
  }
  if (dynamicFee.reductionFactor > BASIS_POINT_MAX) {
    issues.push({
      code: "invalid_dynamic_fee",
      detail: `reduction_factor=${dynamicFee.reductionFactor}`,
    });
  }
  if (dynamicFee.variableFeeControl > U24_MAX) {
    issues.push({
      code: "invalid_dynamic_fee",
      detail: `variable_fee_control=${dynamicFee.variableFeeControl}`,
    });
  }
  if (dynamicFee.maxVolatilityAccumulator > U24_MAX) {
    issues.push({
      code: "invalid_dynamic_fee",
      detail: `max_volatility_accumulator=${dynamicFee.maxVolatilityAccumulator}`,
    });
  }
  return issues;
}

function validateConfig(row: ConfigRow): Issue[] {
  const { account } = row;
  const issues: Issue[] = [];

  const configType = account.configType as ConfigType;
  if (configType !== ConfigType.Static && configType !== ConfigType.Dynamic) {
    issues.push({ code: "invalid_config_type", detail: String(configType) });
  }

  if (configType === ConfigType.Dynamic) {
    if (account.poolCreatorAuthority.equals(PublicKey.default)) {
      issues.push({
        code: "invalid_pool_creator_authority",
        detail: "dynamic config requires non-default pool_creator_authority",
      });
    }
    return issues;
  }

  const collectFeeMode = account.collectFeeMode as CollectFeeMode;
  const activationType = account.activationType as ActivationType;

  if (collectFeeMode !== CollectFeeMode.Compounding) {
    if (account.sqrtMinPrice.lt(MIN_SQRT_PRICE)) {
      issues.push({ code: "invalid_sqrt_min_price", detail: account.sqrtMinPrice.toString() });
    }
    if (account.sqrtMaxPrice.gt(MAX_SQRT_PRICE)) {
      issues.push({ code: "invalid_sqrt_max_price", detail: account.sqrtMaxPrice.toString() });
    }
    if (!account.sqrtMinPrice.lt(account.sqrtMaxPrice)) {
      issues.push({ code: "invalid_price_range", detail: "sqrt_min_price >= sqrt_max_price" });
    }
  } else {
    const u128Max = new BN("340282366920938463463374607431768211455");
    if (!account.sqrtMinPrice.isZero() || !account.sqrtMaxPrice.eq(u128Max)) {
      issues.push({
        code: "invalid_compounding_price_range",
        detail: `expected sqrt_min=0 sqrt_max=u128::MAX, got ${account.sqrtMinPrice.toString()} / ${account.sqrtMaxPrice.toString()}`,
      });
    }
  }

  const compoundingFeeBps = account.poolFees.compoundingFeeBps;

  if (collectFeeMode === CollectFeeMode.Compounding) {
    if (compoundingFeeBps <= 0 || compoundingFeeBps > BASIS_POINT_MAX) {
      issues.push({
        code: "invalid_compounding_fee_bps",
        detail: String(compoundingFeeBps),
      });
    }
  } else if (compoundingFeeBps !== 0) {
    issues.push({
      code: "invalid_compounding_fee_bps",
      detail: `expected 0 for collect_fee_mode=${collectFeeMode}, got ${compoundingFeeBps}`,
    });
  }

  issues.push(...validateDynamicFee(account.poolFees.dynamicFee));

  const baseFeeData = Buffer.from(account.poolFees.baseFee.data);
  const baseFeeMode = baseFeeData[8] as BaseFeeMode;

  switch (baseFeeMode) {
    case BaseFeeMode.FeeTimeSchedulerLinear:
    case BaseFeeMode.FeeTimeSchedulerExponential:
      issues.push(...validateTimeScheduler(baseFeeData));
      break;
    case BaseFeeMode.FeeMarketCapSchedulerLinear:
    case BaseFeeMode.FeeMarketCapSchedulerExponential:
      issues.push(...validateMarketCapScheduler(baseFeeData));
      break;
    case BaseFeeMode.RateLimiter:
      issues.push(...validateRateLimiter(baseFeeData, collectFeeMode, activationType));
      break;
    default:
      issues.push({ code: "unknown_base_fee_mode", detail: String(baseFeeMode) });
  }

  return issues;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });

  const idl = { ...(idlRaw as Idl), address: CP_AMM_PROGRAM_ID.toBase58() };
  const program = new Program(idl as Idl, provider) as Program<CpAmm>;

  console.log(`RPC:     ${RPC}`);
  console.log(`Program: ${CP_AMM_PROGRAM_ID.toBase58()}\n`);

  const rows = (await program.account.config.all()) as ConfigRow[];
  rows.sort((a, b) => a.account.index.cmp(b.account.index));

  if (rows.length === 0) {
    console.log("No config accounts found.");
    return;
  }

  let failed = 0;

  for (const row of rows) {
    const { account } = row;
    const configType = account.configType === 0 ? "static" : "dynamic";
    const issues = validateConfig(row);
    const status = issues.length === 0 ? "OK" : "FAIL";

    console.log(
      `[${status}] index=${account.index.toString()} type=${configType} ${row.publicKey.toBase58()}`
    );
    console.log(
      `       pool_creator=${account.poolCreatorAuthority.toBase58()} collect_fee_mode=${account.collectFeeMode} activation_type=${account.activationType}`
    );

    if (issues.length > 0) {
      failed += 1;
      for (const issue of issues) {
        console.log(`       ✗ ${issue.code}: ${issue.detail}`);
      }
    }
  }

  console.log(`\nSummary: ${rows.length - failed}/${rows.length} configs passed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
