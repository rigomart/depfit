import * as peer from "peer";
self.onmessage = () => self.postMessage(Object.keys(peer));
