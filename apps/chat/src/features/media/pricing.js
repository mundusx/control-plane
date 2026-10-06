import { httpError } from "../../shared/http-error.js";

export const IMAGE_PROFILE = "qwen-image-fp8-832x480-v1";
export const LEGACY_IMAGE_PROFILE = "qwen-image-fp8-1024-v1";

// Verified GX10 sample. Reward denomination is policy; measured seconds calibrate
// the workload rate. Individual worker runtime never reprices a stored quote.
export const IMAGE_REFERENCE_BENCHMARK = Object.freeze({
  width:832, height:480, steps:30, generation_ms:128178, reward_credits:1199,
  hardware:'NVIDIA GB10', verified_at:1791131952,
  artifact_sha256:'dddf5e5ebaa39f726d15dce5ecbcb1c4b8d9c45fea573ac8478f466157abf548',
});
const referencePixelSteps = IMAGE_REFERENCE_BENCHMARK.width * IMAGE_REFERENCE_BENCHMARK.height * IMAGE_REFERENCE_BENCHMARK.steps;
export const IMAGE_CREDITS_PER_REFERENCE_SECOND = IMAGE_REFERENCE_BENCHMARK.reward_credits / (IMAGE_REFERENCE_BENCHMARK.generation_ms / 1000);
export const IMAGE_CREDITS_PER_MEGAPIXEL_STEP =
  (IMAGE_REFERENCE_BENCHMARK.generation_ms / 1000) * IMAGE_CREDITS_PER_REFERENCE_SECOND / (referencePixelSteps / 1_000_000);
export function imageQuote(profile = IMAGE_PROFILE) {
  if (profile !== IMAGE_PROFILE && profile !== LEGACY_IMAGE_PROFILE) throw httpError(422, "Image profile is not benchmarked or priced");
  const legacy = profile === LEGACY_IMAGE_PROFILE;
  const width = legacy ? 1024 : 832, height = legacy ? 1024 : 480, steps = 30;
  const pixelSteps = width * height * steps;
  // Integer reference ratio avoids floating-point cancellation adding a credit.
  const credits = legacy ? 4 : Math.ceil(pixelSteps * IMAGE_REFERENCE_BENCHMARK.reward_credits / referencePixelSteps);
  return {
    pricing_version: legacy ? "image-compute-v1" : "image-benchmark-megapixel-steps-v2", profile_id: profile,
    operation: "text_to_image", model: "Qwen/Qwen-Image", width, height,
    steps, image_count: 1, compute_credits: credits, contributor_reward_credits: credits,
    ...(legacy ? {reference_generation_ms:216337, reference_seconds_per_credit:60} : {
      credits_per_megapixel_step:IMAGE_CREDITS_PER_MEGAPIXEL_STEP, pixel_count:width*height,
      megapixel_steps:pixelSteps/1_000_000, rate_status:'provisional_single_run_calibration',
      reference_generation_ms:IMAGE_REFERENCE_BENCHMARK.generation_ms,
      estimated_generation_ms:IMAGE_REFERENCE_BENCHMARK.generation_ms * pixelSteps / referencePixelSteps,
      requested_pixel_steps:pixelSteps, reference_pixel_steps:referencePixelSteps,
      reference_reward_credits:IMAGE_REFERENCE_BENCHMARK.reward_credits,
      credits_per_reference_second:IMAGE_CREDITS_PER_REFERENCE_SECOND,
      benchmark:{...IMAGE_REFERENCE_BENCHMARK},
      rate_formula:'reference_generation_seconds * credits_per_reference_second / reference_megapixel_steps',
    }),
    calibration: legacy ? "provisional_single_gx10_run" : "verified_gx10_seconds_with_policy_reward_anchor", currency: "credits",
    formula: legacy ? "ceil(reference_generation_ms / 60000)" : "ceil(requested_pixel_steps * reference_reward_credits / reference_pixel_steps)",
    cash_price: null, file_retention_seconds: 172800,
  };
}

export const VIDEO_PROFILES = {
  'wan22-5b-704p-49f-v1': { frames: 49, reference_generation_ms: 208508 },
  'wan22-5b-704p-121f-v1': { frames: 121, reference_generation_ms: 535361 },
  'wan22-5b-704p-241f-v1': { frames: 241, reference_generation_ms: 1212278 },
  // 33 frames measured on GX10; longer presets provisionally scale by frame count.
  'wan22-14b-704p-33f-v1': { fps: 16, frames: 33, reference_generation_ms: 893905, model: 'Wan-AI/Wan2.2-T2V-A14B' },
  'wan22-14b-704p-81f-v1': { fps: 16, frames: 81, reference_generation_ms: 2194131, reference_estimated: true, model: 'Wan-AI/Wan2.2-T2V-A14B' },
  'wan22-14b-704p-161f-v1': { fps: 16, frames: 161, reference_generation_ms: 4361173, reference_estimated: true, model: 'Wan-AI/Wan2.2-T2V-A14B' },
};
// Integer 1-10 second presets use the measured 33-frame baseline.
for (let seconds = 1; seconds <= 10; seconds++) {
  const frames = seconds * 16 + 1, id = `wan22-14b-704p-${frames}f-v1`;
  VIDEO_PROFILES[id] ??= { fps: 16, frames, reference_generation_ms: Math.ceil(893905 * frames / 33), reference_estimated: true, model: 'Wan-AI/Wan2.2-T2V-A14B' };
}
// Keep the old per-duration rate until 480p is benchmarked on GX10.
for (let seconds = 1; seconds <= 10; seconds++) {
  const frames = seconds * 16 + 1;
  VIDEO_PROFILES[`wan22-14b-480p-${frames}f-v1`] = { ...VIDEO_PROFILES[`wan22-14b-704p-${frames}f-v1`], width: 832, height: 480, calibration: 'provisional_legacy_rate_pending_benchmark', reference_estimated: true };
}
export const ACTIVE_I2V_PROFILES = [];
for (let seconds = 1; seconds <= 10; seconds++) {
  const frames = seconds * 16 + 1, id = `wan22-i2v-lightning-14b-480p-${frames}f-v3`;
  ACTIVE_I2V_PROFILES.push(id);
  VIDEO_PROFILES[id] = { fps: 16, frames, width: 832, height: 480, steps: 4,
    operation: 'image_to_video', model: 'Wan-AI/Wan2.2-I2V-A14B-Lightning',
    reference_generation_ms: Math.ceil(146360 * frames / 33), reference_estimated: true,
    calibration: 'estimated_from_2s_gx10_fast_i2v_before_padding' };
}
export const ACTIVE_VIDEO_PROFILES = Object.keys(VIDEO_PROFILES).filter(id => id.startsWith('wan22-14b-480p-') && VIDEO_PROFILES[id].reference_generation_ms > 0).sort((a,b) => VIDEO_PROFILES[a].frames - VIDEO_PROFILES[b].frames);
export function mediaQuote(profile = IMAGE_PROFILE) {
  if (profile === IMAGE_PROFILE || profile === LEGACY_IMAGE_PROFILE) return imageQuote(profile);
  const preset = Object.hasOwn(VIDEO_PROFILES, profile) ? VIDEO_PROFILES[profile] : null;
  if (!preset || !(preset.reference_generation_ms > 0)) throw httpError(422, 'Media profile is not benchmarked or priced');
  return { pricing_version: preset.width === 832 ? 'video-compute-v3' : preset.model ? 'video-compute-v2' : 'video-compute-v1', profile_id: profile, operation: preset.operation ?? 'text_to_video', model: preset.model ?? 'Wan-AI/Wan2.2-TI2V-5B',
    width: preset.width ?? 1280, height: preset.height ?? 704, steps: preset.steps ?? 20, frames: preset.frames, fps: preset.fps ?? 24, duration_seconds: preset.frames/(preset.fps ?? 24),
    compute_credits: Math.ceil(preset.reference_generation_ms/60000), contributor_reward_credits: Math.ceil(preset.reference_generation_ms/60000),
    reference_generation_ms: preset.reference_generation_ms, reference_seconds_per_credit: 60,
    calibration: preset.calibration ?? (preset.reference_estimated ? 'estimated_from_2s_gx10_frame_count' : 'provisional_single_gx10_run'),
    reference_estimated: preset.reference_estimated === true,
    currency: 'credits', formula: 'ceil(reference_generation_ms / 60000)', cash_price: null, file_retention_seconds: 172800 };
}
