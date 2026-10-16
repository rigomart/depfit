import { shared } from "./shared.js";
export const eager = () => shared("eager");
export const later = () => import("./later.js");
