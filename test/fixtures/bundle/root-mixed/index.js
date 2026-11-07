export const small = () => 1;
export const large = () => "large".repeat(100);
export const remote = () => import("https://example.com/code.js");
export default function main() {
  return 2;
}
