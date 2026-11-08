# Real scripts the model wrote on allowance-demo

Copied verbatim from the bot's comments on `edycutjong/allowance-demo` issues #1–#7 (the comment id is in each
file name). `test/script-check.test.ts` runs every one through the gate:

- `pass-*` — the scripts that ran and decided a verdict; the gate must keep accepting them.
- `refused-*` — the pre-gate #1 run (arithmetic, no project call) and the #7 script whose repair was refused; the
  gate must keep refusing them.
