// Fencing untrusted content.
//
// Everything the model is shown about a person is data they wrote, or data a
// bank feed wrote, or something the model itself said yesterday. None of it is
// an instruction, and the difference has to be visible in the text rather than
// merely asserted somewhere else in the prompt.
//
// SPEC 2.2: the notebook is DATA, never INSTRUCTIONS.

const crypto = require('crypto');

const LABEL = 'UNTRUSTED USER DATA';

/**
 * Wrap content so it cannot pretend to be anything else.
 *
 * The marker carries a fresh random nonce, and the nonce is regenerated until
 * it does not occur anywhere in the content. So the closing marker is a string
 * the content provably does not contain, and no title, note or merchant name
 * can end the block early and have what follows read as instruction.
 *
 * A fixed marker would not do this: anyone who has seen the prompt format once
 * could type the closing line into an entry title.
 */
function fence(content) {
  const text = String(content ?? '');

  let nonce;
  do {
    nonce = crypto.randomBytes(9).toString('hex');
  } while (text.includes(nonce));

  return [
    `-----BEGIN ${LABEL} ${nonce}-----`,
    text,
    `-----END ${LABEL} ${nonce}-----`,
  ].join('\n');
}

module.exports = { fence, LABEL };
