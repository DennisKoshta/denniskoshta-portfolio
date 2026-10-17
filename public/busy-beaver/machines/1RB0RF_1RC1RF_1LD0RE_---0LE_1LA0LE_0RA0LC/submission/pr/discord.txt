**A recursive Bell-eats-counter machine never halts**

`1RB0RF_1RC1RF_1LD0RE_---0LE_1LA0LE_0RA0LC`

PR: https://github.com/ccz181078/busycoq/pull/25

A marker moves along the tape while incrementing a counter. When its budget runs out, it consumes one counter digit and leaves a residue. Cleaning up that residue can launch a whole nested epoch inside a single outer bounce.

The proof bounds that cleanup with weighted potentials: it always finishes before the next potentially unsafe consumption. A checked prefix of 691 epochs reaches budget 17,713; from there, an invariant gives an infinite run.

The marker bounce comes from FractalBEC's tm10. The partial consumption and recursive cleanup need their own argument. This submission covers a different blank start of the transition table whose two other starts appear in PR #22.

The Rocq file proves `nonhalt: ~halts tm c0.` against busycoq BB6. `Print Assumptions nonhalt` is closed.

Write-up (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/recursive-bell/writeups.zip
Image (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/recursive-bell/images.zip

AI assistance: the original proof, proof sketch and checks were produced with the help of Claude (Anthropic); independent audit and submission preparation with GPT-6 Astra (OpenAI).
