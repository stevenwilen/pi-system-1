# Planning rules

Notes, not data. Nothing reads this file: the system holds no observations any
more, and under the current design it never infers how someone works. These are
kept because they were learned once and would otherwise be lost.

They were recorded between 26 and 27 July 2026 as `observation` rows, retired in
the simplification, and captured here before the columns holding them were
dropped. Where a note says the person stated something directly, that is what the
row recorded at the time.

---

## Shape of the day

**The hour after the morning routine is the best hour.**
The routine runs about an hour from wake time and covers breakfast, water and
getting ready. Immediately after it comes the clearest and most motivated
stretch of the day. The gym, the hardest tasks and the hardest projects belong
in that window.
*Stated directly.*

**Thirty minutes after the gym before anything else.**
Time to eat and rest. Not a gap to be filled.
*Inferred from a correction: asked for a 30-minute buffer after the gym when
planning a day, saying he needed to eat and rest before moving on.*

## Scheduling constraints

**Gym and walk never fall on the same day.**
They are mutually exclusive. Never place both.
*Stated directly.*

**Small tasks are batched, not spread.**
Quick errands go into one block rather than several separate ones. Two examples
recorded at the time: Setup Baselang plus Book Haircut in a single 30-minute
block, and Buy Tires plus Research Check Engine in one two-hour block.
*Inferred from a correction to a day plan that had spread them out.*

## Circumstances at the time

These were true in July 2026 and are the most likely of these notes to have
gone stale.

**No income yet; new job starting 16 August 2026.**
*Stated directly.*

**Custodial account, all in an S&P 500 fund.**
Recorded as an idea rather than a rule: worth exploring individual holdings, but
the account is inaccessible for roughly two years, so there was no urgency.

---

Under the current design these would be declared, not discovered. The gym and
walk exclusion, the post-routine window and the batching preference are the kind
of thing the builder now expects the person to apply themselves, and the income
timing is the kind of thing the finance lane expects as a `finance_intent` row
of kind `situation`.
