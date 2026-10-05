import { verifyCart, verifyMandate } from "./sign.js";
import type { AuthorizationCheck, Purchase, SignedCart, SignedMandate } from "./types.js";

/**
 * Checks who signed what. Two separate signers:
 *  - the USER signed the mandate (limits, merchants, categories, expiry), with a key the agent does not hold;
 *  - the AGENT signed the cart (this exact purchase), binding it to that mandate by id and hash.
 * Pure function: callers look up the keys. A missing key counts as a failed signature.
 */
export function verifyAuthorization(i: {
  signedMandate: SignedMandate;
  signedCart?: SignedCart;
  userPublicKeyPem?: string;
  agentPublicKeyPem?: string;
  purchase: Purchase;
}): AuthorizationCheck {
  const { signedMandate: sm, signedCart: sc, purchase: p } = i;
  const problems: string[] = [];

  const mandateSignedByUser = i.userPublicKeyPem ? verifyMandate(sm, i.userPublicKeyPem) : false;
  if (!mandateSignedByUser) {
    problems.push(i.userPublicKeyPem
      ? `The mandate was not signed by the registered key of user ${sm.mandate.userId}.`
      : `No key is registered for user ${sm.mandate.userId}, so the mandate signature cannot be verified.`);
  }

  let cartSignedByAgent = false, cartBoundToMandate = false, cartMatchesPurchase = false;
  if (!sc) {
    problems.push("No signed cart: nothing shows the agent chose this purchase under the mandate.");
  } else {
    cartSignedByAgent = i.agentPublicKeyPem ? verifyCart(sc, i.agentPublicKeyPem) : false;
    if (!cartSignedByAgent) {
      problems.push(i.agentPublicKeyPem
        ? `The cart was not signed by the registered key of agent ${sm.mandate.agentId}.`
        : `No key is registered for agent ${sm.mandate.agentId}, so the cart signature cannot be verified.`);
    }
    const c = sc.cart;
    cartBoundToMandate = c.mandateId === sm.mandate.id && c.mandateHash === sm.mandateHash && c.agentId === sm.mandate.agentId;
    if (!cartBoundToMandate) problems.push("The cart does not refer to this mandate (id, hash or agent differs).");
    cartMatchesPurchase = c.merchantId === p.merchantId && c.amountCents === p.amountCents
      && c.currency === p.currency && (c.category ?? null) === (p.category ?? null);
    if (!cartMatchesPurchase) problems.push("The signed cart does not match the purchase that was made.");
  }

  return {
    ok: problems.length === 0,
    mandateSignedByUser, cartSignedByAgent, cartBoundToMandate, cartMatchesPurchase, problems,
  };
}