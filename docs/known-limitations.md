# Known limitations: how far back history goes

VestLens reads your accounts through SnapTrade. Holdings and balances are current,
but **transaction history (deposits, withdrawals, trades, dividends) only goes back
as far as SnapTrade can get it from your brokerage.** For older accounts, that is
usually later than the day the account opened.

## The Wealthsimple cut-off

- SnapTrade says Wealthsimple limited how far back history goes when it moved to a
  new reporting system. The cut-off SnapTrade gives is **around April 2023**. In
  testing, some accounts reached a few months earlier than that, so treat the date
  as approximate.
- Older transactions can't be recovered through SnapTrade, and VestLens has no other
  source for them.
- SnapTrade's own guidance is that history "often" covers years and only "sometimes"
  goes back to the start of the account. A sync that finishes doesn't prove the
  history is complete.

## What to expect

If your account is older than the cut-off:

| Figure | What you'll see |
|---|---|
| Holdings, balances, account totals | Correct. These come from the brokerage's current numbers, not from history. |
| All-time deposits, withdrawals, net deposits | **Lower than Wealthsimple's app shows**, because deposits made before the cut-off are missing. |
| Returns net of deposits | Measured only from the first transaction VestLens has. They aren't all-time returns. |
| Activity and buy/sell charts | Start at the cut-off, not when the account opened. |
| TFSA / FHSA contribution room | Years the history doesn't fully cover are incomplete. Check your room in CRA My Account and tell VestLens about earlier contributions. |

**How to find your own cut-off date:** open the Activity view for the account. The
oldest transaction listed is where VestLens's history starts. The app doesn't yet
label this date for you.

## Other things to watch for

- **A cancelled recurring deposit can show up as a normal deposit.** Wealthsimple
  sends it through SnapTrade with nothing marking it cancelled, so deposit totals
  can come out too high by that amount.
- **Dates follow UTC.** A deposit made late in the evening (Toronto time) can show
  on the next day. Near 31 December, that can move it into the next contribution
  year.
- **Wealthsimple managed (Invest/Robo) accounts may not be available through
  SnapTrade at all.** Check SnapTrade's current Wealthsimple guidance.
