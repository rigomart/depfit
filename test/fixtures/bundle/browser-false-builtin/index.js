let random;
if (typeof self === "object" && self.crypto) random = (n) => self.crypto.getRandomValues(new Uint8Array(n));
else {
  const crypto = require("crypto");
  random = (n) => crypto.randomBytes(n);
}
exports.random = random;
