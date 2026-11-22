import { readRequestFileBar } from './requestFileBar';

self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(readRequestFileBar(event.data, { includeRanges: true }));
};
