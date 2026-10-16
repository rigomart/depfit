const code = "self.onmessage = (event) => self.postMessage(event.data);";
export const start = () => new Worker(URL.createObjectURL(new Blob([code])));
