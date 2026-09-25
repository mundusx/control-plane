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
