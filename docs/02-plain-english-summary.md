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
| The assistant bought $135 shoes; the limit was $120. Buyer disputes. | **Suggest refunding the $15 extra.** | The first $120 was authorized; the extra $15 wasn't. PayPal's test system only lets the shop concede the whole payment at this stage, so Warrant shows the suggestion and tells the shop owner to refund the $15 themselves in PayPal. It never sends something PayPal would reject. |
| The assistant bought a $115 gadget; the slip only covered shoes. Buyer disputes. | **Accept the claim.** | The purchase went beyond what the buyer allowed. Fighting it would be weak. |

## Where the AI comes in, and where it doesn't

The AI has one job: **explaining and writing.** It turns the facts into a clear summary for you and drafts the note that goes to PayPal.

The AI does **not** decide anything. The decision comes from simple, fixed rules that anyone can read and check. The AI can't change the decision, can't send anything to PayPal, and its writing is automatically checked (for example, it isn't allowed to mention an amount that isn't in the facts). If the AI misbehaves or isn't available, Warrant falls back to plain template text and tells you so. And you always have the final say.

We designed it this way on purpose: when money is involved, we want the judgment calls to be predictable and the AI to be a helper, not the boss.

## What exists today

- The permission-slip signing and checking works and is tested.
- The rule-based decisions work and are tested.
- The review screen for the shop owner works against PayPal's test environment.
- A pretend shopper (a scripted assistant) can run through all three examples above, and can also turn a plain request like "buy trail running shoes under $120" into a signed permission slip and a real test purchase.
- A buyer can connect a PayPal Sandbox payment method through PayPal Vault. Once connected, the saved payment method can be charged by the autonomous-payment path without another buyer approval click.
- **It has been run against PayPal's test environment (the "sandbox").** A test purchase was made, the buyer raised an "unauthorized" dispute, Warrant matched it to the signed slip, and the shop owner's approval sent the response to PayPal. Two of the three responses worked: fighting the dispute (PayPal accepted the evidence and put the case under review) and accepting it (the buyer was refunded). The third, offering a partial refund, isn't available from PayPal for this kind of dispute, which is why Warrant shows it as a suggestion only.
- Three optional add-ons were each run live: real product search *and verification of what was actually bought* (Channel3), a searchable log of the shop-side agent's steps plus similar-past-case lookup (Elastic), and a two-way evidence loop that fetches delivery proof and posts it back (Zapier).
- A live, running copy is deployed on the internet (Render), with PayPal's automatic dispute alert wired up for real: a test dispute reached it and Warrant handled it with no one touching a keyboard.
- There's also a dashboard (built with AG Studio) that charts dispute rates per shopping assistant, which responses get used most, and more — pre-built, and a chat assistant on the same page can answer questions about the data or build new charts on request.
- You can also watch the whole story run on your computer with no PayPal account, using one command (`npm run demo:offline`).

## What is not done or not proven yet

- **The permission slip is signed by the shopper's assistant, not by the buyer personally.** So it proves the assistant issued it, not that the human did. Having the buyer's own key sign it is the most important next step.
- **The default demo uses a person clicking "Pay Now."** Warrant also supports connecting a PayPal Vault payment method for autonomous payment; the connection and full browser-driven no-click checkout have been verified in the sandbox.
- **The product category is whatever the assistant says it is.** Warrant doesn't check that a "shoe" is really a shoe.
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