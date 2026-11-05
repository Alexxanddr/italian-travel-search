import { createServer } from '../../dist/app.js';

globalThis.fetch = async () => { throw new Error('Synthetic provider server forbids outbound fetch'); };

const server = createServer({
  providers: [{
    id: 'itabus', status: 'available',
    searchLocations: async query => [{ provider: 'itabus', id: query, name: query, city: query, source: 'live' }],
    searchJourneys: async input => [{
      provider: 'itabus', tripId: 'synthetic-production',
      origin: {id:'ROM',name:'Roma Tiburtina'}, destination:{id:'REN',name:'Rende Cosenza Nord'},
      departure:`${input.date}T18:00:00Z`, arrival:`${input.date}T20:00:00Z`, durationMinutes:120,
      available:true, price:{amount:25,currency:'EUR'}, bookingUrl:'https://app.itabus.it/',
    }],
  }],
  railProviders: [], railLiveProviders: [],
}).listen(Number(process.env.PORT ?? 4174), process.env.HOST ?? '127.0.0.1');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
