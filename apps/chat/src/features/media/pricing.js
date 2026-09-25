import { httpError } from "../../shared/http-error.js";

export const IMAGE_PROFILE = "qwen-image-fp8-1024-v1";

// Provisional calibration: one verified GX10 run took 216,337 ms.
// The reference work is priced once, never from a contributor's claimed runtime.
export function imageQuote(profile = IMAGE_PROFILE) {
  if (profile !== IMAGE_PROFILE) throw httpError(422, "Image profile is not benchmarked or priced");
  return {
    pricing_version: "image-compute-v1", profile_id: IMAGE_PROFILE,
    operation: "text_to_image", model: "Qwen/Qwen-Image", width: 1024, height: 1024,
    steps: 30, image_count: 1, compute_credits: 4, contributor_reward_credits: 4,
    reference_generation_ms: 216337, reference_seconds_per_credit: 60,
    calibration: "provisional_single_gx10_run", currency: "credits",
    formula: "ceil(reference_generation_ms / 60000)",
    cash_price: null, file_retention_seconds: 172800,
  };
}

export const VIDEO_PROFILES = {
  'wan22-5b-704p-49f-v1': { frames: 49, reference_generation_ms: 208508 },
  'wan22-5b-704p-121f-v1': { frames: 121, reference_generation_ms: 535361 },
  'wan22-5b-704p-241f-v1': { frames: 241, reference_generation_ms: 1212278 },
};
export function mediaQuote(profile = IMAGE_PROFILE) {
  if (profile === IMAGE_PROFILE) return imageQuote(profile);
  const preset = Object.hasOwn(VIDEO_PROFILES, profile) ? VIDEO_PROFILES[profile] : null;
  if (!preset) throw httpError(422, 'Media profile is not benchmarked or priced');
  return { pricing_version: 'video-compute-v1', profile_id: profile, operation: 'text_to_video', model: 'Wan-AI/Wan2.2-TI2V-5B',
    width: 1280, height: 704, steps: 20, frames: preset.frames, fps: 24, duration_seconds: preset.frames/24,
    compute_credits: Math.ceil(preset.reference_generation_ms/60000), contributor_reward_credits: Math.ceil(preset.reference_generation_ms/60000),
    reference_generation_ms: preset.reference_generation_ms, reference_seconds_per_credit: 60,
    calibration: 'provisional_single_gx10_run', currency: 'credits', formula: 'ceil(reference_generation_ms / 60000)', cash_price: null, file_retention_seconds: 172800 };
}
