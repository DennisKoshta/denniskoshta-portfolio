Two sync bouncer counters: nonhalting proofs submitted in https://github.com/ccz181078/busycoq/pull/24

`1RB0LA_0RC1RD_0LD1RE_1LA0RB_0RD1RF_1RC---`
`1RB---_0LC1RF_1LE0RD_0RB1RC_1RD0LE_0RC1RA`

These are different blank-start orbits of the same transition table, up to state renaming. A binary counter on the left drives a front through a row of blocks. Each overflow adds a digit; the front eventually converts the blocks and begins another cycle. Sometimes the next overflow arrives while the conversion is still running.

The useful simplification is that the cycle map has two affine branches, and both preserve one hexagon in the scaled block counts. We never need to predict which parity branch comes next. The two runs enter this invariant after 17,215 and 16,590 steps.

Both holdouts appear in dyuan01's October 1 longitudinal-filter list. The proofs build on the particles and digits of SBCv7 TM4, with direct window lemmas and the shared arithmetic invariant.

Each file proves blank-tape nonhalting on its exact machine string.
Write-ups (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/sync-counter/writeups.zip
Images (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/sync-counter/images.zip

AI assistance: proofs and original write-ups with Claude (Anthropic); independent review and submission preparation with GPT-6 Astra (OpenAI).
