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
export const ACTIVE_VIDEO_PROFILES = Object.keys(VIDEO_PROFILES).filter(id => id.startsWith('wan22-14b-') && VIDEO_PROFILES[id].reference_generation_ms > 0).sort((a,b) => VIDEO_PROFILES[a].frames - VIDEO_PROFILES[b].frames);
export function mediaQuote(profile = IMAGE_PROFILE) {
  if (profile === IMAGE_PROFILE) return imageQuote(profile);
  const preset = Object.hasOwn(VIDEO_PROFILES, profile) ? VIDEO_PROFILES[profile] : null;
  if (!preset || !(preset.reference_generation_ms > 0)) throw httpError(422, 'Media profile is not benchmarked or priced');
  return { pricing_version: preset.model ? 'video-compute-v2' : 'video-compute-v1', profile_id: profile, operation: 'text_to_video', model: preset.model ?? 'Wan-AI/Wan2.2-TI2V-5B',
    width: 1280, height: 704, steps: 20, frames: preset.frames, fps: preset.fps ?? 24, duration_seconds: preset.frames/(preset.fps ?? 24),
    compute_credits: Math.ceil(preset.reference_generation_ms/60000), contributor_reward_credits: Math.ceil(preset.reference_generation_ms/60000),
    reference_generation_ms: preset.reference_generation_ms, reference_seconds_per_credit: 60,
    calibration: preset.reference_estimated ? 'estimated_from_2s_gx10_frame_count' : 'provisional_single_gx10_run',
    reference_estimated: preset.reference_estimated === true,
    currency: 'credits', formula: 'ceil(reference_generation_ms / 60000)', cash_price: null, file_retention_seconds: 172800 };
}
