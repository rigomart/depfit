(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else if (typeof define === "function" && define.amd) define([], factory);
  else root.UmdDefine = factory();
})(this, function () {
  return { answer: 42 };
});
