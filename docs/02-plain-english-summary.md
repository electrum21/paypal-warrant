# Warrant, in plain English

*A non-technical summary. No jargon needed.*

## The idea in one minute

More and more, people will tell an AI assistant, "Go buy me a pair of trail running shoes, but spend no more than $120." The assistant goes and does it.

Now imagine you run the online shop that sold those shoes. A few weeks later, the buyer contacts PayPal and says, "I never authorized this payment." PayPal opens a **dispute**. As the shop owner, you now have to prove the purchase was legitimate, and all you have is a payment record. You can't show what the buyer actually asked their assistant to do.

**Warrant fixes that.** It works like this:

1. When the buyer's assistant shops, it shows the shop a **signed permission slip** (we call it a *mandate*): what the buyer wanted, the most they'd spend, which shop, which kind of product, and for how long. It is signed with a digital signature that can't be faked or edited afterwards.
2. If a dispute happens later, Warrant pulls out that slip and **checks the purchase against it**. Was it the right shop? Under the limit? The right kind of product? Still valid? Was the slip genuine?
3. Warrant then **suggests a response** to the dispute: fight it, offer a partial refund, or accept it.
4. It writes up the evidence in plain language so you can read it quickly.
5. **You approve it.** Only after you click the button does anything go to PayPal.

## Three examples

| What happened | What Warrant suggests | Why |
|---|---|---|
| The assistant bought $115 shoes; the limit was $120. Buyer disputes. | **Fight the dispute.** | The buyer's own signed instructions allowed it. |
| The assistant bought $135 shoes; the limit was $120. Buyer disputes. | **Offer to refund $15.** | The first $120 was authorized; the extra $15 wasn't. A fair offer is more likely to settle things. |
| The assistant bought a $115 gadget; the slip only covered shoes. Buyer disputes. | **Accept the claim.** | The purchase went beyond what the buyer allowed. Fighting it would be weak. |

## Where the AI comes in, and where it doesn't

The AI has one job: **explaining and writing.** It turns the facts into a clear summary for you and drafts the note that goes to PayPal.

The AI does **not** decide anything. The decision comes from simple, fixed rules that anyone can read and check. The AI can't change the decision, can't send anything to PayPal, and its writing is automatically checked (for example, it isn't allowed to mention an amount that isn't in the facts). If the AI misbehaves or isn't available, Warrant falls back to plain template text and tells you so. And you always have the final say.

We designed it this way on purpose: when money is involved, we want the judgment calls to be predictable and the AI to be a helper, not the boss.

## What exists today

- The permission-slip signing and checking works and is tested.
- The rule-based decisions work and are tested.
- The review screen for the shop owner exists and works against a pretend PayPal.
- A pretend shopper (a scripted assistant) can run through all three examples above.
- You can watch the whole story run on your computer today, with no PayPal account, using one command (`npm run demo:offline`).

## What is not done or not proven yet

- **Nothing has been tried against PayPal's real test environment (the "sandbox") yet.** That is the next big step, and some details of how PayPal's dispute system accepts our responses are still guesses.
- It is a hackathon project, so it only ever talks to PayPal's test environment, never real money.
- We built both the shopper's assistant and the shop's side ourselves; PayPal's real dispute process isn't re-created beyond what the test environment offers.
- Our permission-slip format is *inspired by* an industry proposal for agent payments (AP2), but it is not the official standard.
- A signed slip is *evidence*. It helps, but nobody can promise how PayPal will rule.

## Why it could matter

If AI assistants are going to spend our money, shops need a trustworthy way to show what was agreed, and buyers need to know their limits are respected. Warrant is a small, honest version of that: clear permission, rule-based checking, fair outcomes, and a human in charge.

## Words you might hear

- **Mandate:** the signed permission slip from the buyer to their AI assistant.
- **Dispute:** a buyer asking PayPal to reverse a payment.
- **Evidence pack:** the shop's file of proof for a dispute.
- **Sandbox:** PayPal's practice environment where no real money moves.
- **Webhook:** an automatic message PayPal sends us when something happens, such as a new dispute.
- **Agent:** an AI program that acts on someone's behalf.
