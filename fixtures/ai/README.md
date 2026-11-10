# Recorded NEAR AI Cloud responses (A9)

`QORVEX_AI_MODE=replay` (the default) answers only from JSON files in this directory: one file per
model call, containing the exact request, the raw response, the chat id and the replay key
(job, model, contract, code hash, source digest, attempt).

This directory is empty until someone runs, with a NEAR AI Cloud key:

    NEARAI_API_KEY=... QORVEX_AI_MODE=record npm run demo -- --auto --exit

Nothing here is hand-written: a fixture is only ever produced by a real API call.
