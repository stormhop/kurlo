import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { buildSchema, graphql } from 'graphql';

const schema = buildSchema(`
  type Query {
    book(id: ID!): Book
    books(limit: Int = 10): [Book!]!
  }
  type Book { id: ID!, title: String!, year: Int!, author: Author! }
  type Author { name: String!, books: [Book!]! }
`);

const books = [
  { id: '1', title: 'A Wizard of Earthsea', year: 1968, writer: 'Ursula K. Le Guin' },
  { id: '2', title: 'The Tombs of Atuan', year: 1971, writer: 'Ursula K. Le Guin' },
  { id: '3', title: 'Kindred', year: 1979, writer: 'Octavia E. Butler' },
];
function bookView(book: typeof books[number]): Record<string, unknown> {
  return { ...book, author: () => ({ name: book.writer, books: () => books.filter(b => b.writer === book.writer).map(bookView) }) };
}
const rootValue = {
  book: ({ id }: { id: string }) => {
    const book = books.find(item => item.id === id);
    return book && bookView(book);
  },
  books: ({ limit }: { limit: number }) => books.slice(0, limit).map(bookView),
};

export async function startCatalogServer(port = 0) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/graphql') {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { query: source, variables: variableValues, operationName } = JSON.parse(Buffer.concat(chunks).toString());
      const result = await graphql({ schema, source, variableValues, operationName, rootValue });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      res.writeHead(400).end();
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing catalog port');
  return { server, url: `http://127.0.0.1:${address.port}/graphql` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCatalogServer(4319).then(({ url }) => console.log(url));
}
