export const start = () => new Worker("./worker.js", { type: "module" });
