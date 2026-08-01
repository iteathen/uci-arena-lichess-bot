// Frozen provider-side fixture for validating the published engine curve artifact contract.
// This is test data, not a fitter or a source of live engine policy.

export const BOUNDS = Object.freeze({
  reference_pool_ms: [1_000, 3_600_000],
  amplitude_base_permille: [0, 16_000],
  amplitude_log_pool_slope_permille: [-16_000, 16_000],
  amplitude_increment_fraction_slope_permille: [-16_000, 16_000],
  span_base_moves: [4, 20],
  span_log_pool_slope_millimoves: [-20_000, 20_000],
  span_increment_fraction_slope_millimoves: [-20_000, 20_000],
  span_min_moves: [4, 20],
  span_max_moves: [4, 20],
  power: [1, 5],
  work_block_batches: [0, 64],
  material_horizon_base_moves: [0, 20],
  material_horizon_slope_permille: [0, 4_000],
});

export const BOOTSTRAP_COEFFICIENTS = Object.freeze({
  reference_pool_ms: 30_000,
  amplitude_base_permille: 8_000,
  amplitude_log_pool_slope_permille: 0,
  amplitude_increment_fraction_slope_permille: 0,
  span_base_moves: 10,
  span_log_pool_slope_millimoves: 3_000,
  span_increment_fraction_slope_millimoves: -16_000,
  span_min_moves: 10,
  span_max_moves: 16,
  power: 3,
  work_block_batches: 8,
  material_horizon_base_moves: 0,
  material_horizon_slope_permille: 0,
});

export function coefficientOptions(revision, coefficients) {
  return {
    McgsTemporalWeightProfile: "AdaptiveCurveV1",
    McgsTemporalCurveRevision: revision,
    McgsTemporalCurveAmplitudePermille: coefficients.amplitude_base_permille,
    McgsTemporalCurveSpan: coefficients.span_base_moves,
    McgsTemporalCurvePower: coefficients.power,
    McgsTemporalWorkBlockBatches: coefficients.work_block_batches,
    McgsTemporalMaterialHorizonBaseMoves: coefficients.material_horizon_base_moves,
    McgsTemporalMaterialHorizonSlopePermille:
      coefficients.material_horizon_slope_permille,
    McgsTemporalCurveReferencePoolMs: coefficients.reference_pool_ms,
    McgsTemporalCurveAmplitudeLogPoolSlopePermille:
      coefficients.amplitude_log_pool_slope_permille,
    McgsTemporalCurveAmplitudeIncrementFractionSlopePermille:
      coefficients.amplitude_increment_fraction_slope_permille,
    McgsTemporalCurveSpanLogPoolSlopeMillimoves:
      coefficients.span_log_pool_slope_millimoves,
    McgsTemporalCurveSpanIncrementFractionSlopeMillimoves:
      coefficients.span_increment_fraction_slope_millimoves,
    McgsTemporalCurveSpanMinMoves: coefficients.span_min_moves,
    McgsTemporalCurveSpanMaxMoves: coefficients.span_max_moves,
  };
}
