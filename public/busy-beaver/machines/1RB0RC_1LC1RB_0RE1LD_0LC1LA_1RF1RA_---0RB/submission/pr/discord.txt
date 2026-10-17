**A nested bell counter never halts**

`1RB0RC_1LC1RB_0RE1LD_0LC1LA_1RF1RA_---0RB`

PR: https://github.com/ccz181078/busycoq/pull/28

The head shuttles between a wall and a binary counter whose bits are three cells apart. Each round consumes two pairs of the bell and decrements the counter. When the bell runs low, the wall bites the counter; a bite on low set bits can open several nested copies of the same process.

The proof keeps two facts: the bell is large enough, and a nonzero residue modulo 3 changes sign at each completed cycle. The tape's left side acts as a stack of pending levels.

The useful part is the induction: we prove safety for every finite number of steps, so we do not need to prove that each nested level eventually returns. After a checked 327-step prefix, the invariant rules out halting forever.

The Rocq file proves `nonhalt: ~halts tm c0.` against busycoq BB6. `Print Assumptions nonhalt` is closed. The low-level rule layout builds on BECv5's TM1.

Write-up (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/bell-counter/writeups.zip
Image (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/bell-counter/images.zip

AI assistance: the original proof, proof sketch and checks were produced with the help of Claude (Anthropic); independent audit and submission preparation with GPT-6 Astra (OpenAI).
