const path = () => "./logo.svg";
export const urls = [
  new URL(("./logo.svg"), import.meta.url),
  new URL(path(), import.meta.url),
  new URL("./logo.svg", import.meta["url"]),
  new URL("./logo.svg", import.meta./* comment */url),
];
