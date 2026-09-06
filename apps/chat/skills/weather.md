# Weather Skill

Purpose: answer weather questions with the weather tool instead of disturbing the LLM.

Rules:

- Use wttr.in for weather, forecast, temperature, humidity, wind, and current condition requests.
- Cache weather responses for two hours when Redis or Valkey is configured.
- If cache is unavailable, call the weather API directly.
- Keep the weather location clean. Remove unrelated follow-up requests such as "tell me your name" or "who created you".
- If a prompt contains weather plus other requests, return the weather result as one section and route the other requests separately.

