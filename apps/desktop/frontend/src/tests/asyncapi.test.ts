import { describe, expect, it } from 'vitest';
import { asyncApiCollectionName, asyncApiImport, parseAsyncApiDocument } from '../lib/asyncapi';
import { detectImportSource } from '../lib/importSource';

const v3 = `asyncapi: 3.0.0
info:
  title: Orders
servers:
  production:
    host: kafka-1.example.com:9093
    protocol: kafka-secure
    description: Production cluster
    security:
      - $ref: '#/components/securitySchemes/sasl'
  staging:
    host: kafka.staging.example.com:9092
    protocol: kafka
channels:
  orderEvents:
    address: orders
    description: Order lifecycle
    messages:
      created:
        $ref: '#/components/messages/OrderCreated'
      cancelled:
        $ref: '#/components/messages/OrderCancelled'
  regionPayments:
    address: payments.{region}
    parameters:
      region:
        enum: [eu, us]
        description: Region code
    messages:
      paid:
        name: PaymentReceived
        payload:
          type: object
          properties:
            amount: { type: number }
operations:
  placeOrder:
    action: receive
    title: Place an order
    channel:
      $ref: '#/channels/orderEvents'
    messages:
      - $ref: '#/channels/orderEvents/messages/created'
      - $ref: '#/channels/orderEvents/messages/cancelled'
  watchOrders:
    action: send
    summary: Order events the service emits
    channel:
      $ref: '#/channels/orderEvents'
components:
  securitySchemes:
    sasl:
      type: scramSha512
  messages:
    OrderCreated:
      name: OrderCreated
      title: Order created
      contentType: application/json
      headers:
        type: object
        properties:
          trace-id: { type: string, example: abc-123 }
      bindings:
        kafka:
          key: { type: string, example: order-42 }
      examples:
        - payload: { id: 42, total: 9.5 }
      payload:
        $ref: '#/components/schemas/Order'
    OrderCancelled:
      name: OrderCancelled
      payload:
        type: object
        required: [id]
        properties:
          id: { type: integer }
          reason: { type: string, enum: [customer, fraud] }
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id: { type: integer }
        total: { type: number }
`;

const v2 = JSON.stringify({
  asyncapi: '2.6.0',
  info: { title: 'Sensors' },
  servers: { local: { url: 'localhost:9092', protocol: 'kafka' } },
  channels: {
    'sensor.readings': {
      publish: { operationId: 'sendReading', message: { name: 'Reading', payload: { type: 'object', properties: { celsius: { type: 'number', example: 21.5 } } } } },
      subscribe: { operationId: 'readReadings', message: { $ref: '#/components/messages/Reading' } },
    },
  },
  components: { messages: { Reading: { payload: { type: 'object' } } } },
});

describe('AsyncAPI import', () => {
  it('is recognised as an import source', () => {
    expect(detectImportSource('orders.yaml', v3)).toBe('asyncapi');
    expect(detectImportSource('sensors.json', v2)).toBe('asyncapi');
  });

  it('builds producers and consumers from an AsyncAPI 3 document', () => {
    const spec = parseAsyncApiDocument(v3);
    expect(asyncApiCollectionName(spec, 'orders.yaml')).toBe('Orders');
    const { requests, variables } = asyncApiImport(spec, 'col', 'Orders', 'specs/orders.yaml');
    expect(requests.map(request => [request.folderPath.join('/'), request.name, request.kafka?.mode])).toEqual([
      ['orders', 'Place an order · Order created', 'produce'],
      ['orders', 'Place an order · OrderCancelled', 'produce'],
      ['orders', 'Order events the service emits', 'consume'],
      ['payments.{region}', 'Produce to payments.{region}', 'produce'],
      ['payments.{region}', 'Consume payments.{region}', 'consume'],
    ]);
    const [created, cancelled, watch, pay, payWatch] = requests;
    expect(created.requestType).toBe('kafka');
    expect(created.url).toBe('{{brokers}}');
    expect(JSON.parse(created.bodyContent)).toEqual({ id: 42, total: 9.5 });
    expect(created.kafka).toMatchObject({ topic: 'orders', key: 'order-42', keyFormat: 'text', format: 'json', tls: true, mechanism: 'SCRAM-SHA-512', schemaPath: 'specs/orders.yaml' });
    expect(created.headers.map(header => [header.key, header.value])).toEqual([['trace-id', 'abc-123']]);
    expect(created.auth).toMatchObject({ type: 'basic', basicUser: '{{kafkaUsername}}', basicPass: '{{kafkaPassword}}' });
    expect(JSON.parse(cancelled.bodyContent)).toEqual({ id: 0, reason: 'customer' });
    expect(watch.kafka).toMatchObject({ mode: 'consume', topics: [{ name: 'orders', schemaPath: 'specs/orders.yaml' }], startFrom: 'latest', stopAfter: 'records', stopValue: '10' });
    expect(pay.kafka).toMatchObject({ topic: 'payments.{{region}}', schemaPath: '' });
    expect(payWatch.kafka?.topics).toEqual([{ name: 'payments.{{region}}' }]);
    expect(variables.map(row => [row.key, row.value, row.enabled])).toEqual([
      ['brokers', 'kafka-1.example.com:9093', true],
      ['brokers', 'kafka.staging.example.com:9092', false],
      ['kafkaUsername', '', true],
      ['kafkaPassword', '', true],
      ['region', 'eu', true],
    ]);
  });

  it('reads AsyncAPI 2 publish as produce and subscribe as consume', () => {
    const { requests, variables } = asyncApiImport(parseAsyncApiDocument(v2), 'col', 'Sensors');
    expect(requests.map(request => [request.name, request.kafka?.mode, request.folderPath])).toEqual([
      ['sendReading', 'produce', []],
      ['readReadings', 'consume', []],
    ]);
    expect(JSON.parse(requests[0].bodyContent)).toEqual({ celsius: 21.5 });
    expect(requests[0].kafka).toMatchObject({ topic: 'sensor.readings', tls: false, schemaPath: '' });
    expect(requests[0].auth.type).toBe('none');
    expect(variables.map(row => [row.key, row.value])).toEqual([['brokers', 'localhost:9092']]);
  });

  it('explains documents it cannot turn into Kafka requests', () => {
    const mqtt = { asyncapi: '3.0.0', info: { title: 'Lights' }, servers: { broker: { host: 'rabbit.example.com', protocol: 'amqp' } }, channels: { on: { address: 'lights/on' } } };
    expect(() => asyncApiImport(mqtt, 'col', 'Lights')).toThrow(/no Kafka or MQTT servers.*amqp/);
    expect(() => asyncApiImport({ asyncapi: '1.2.0' }, 'col', 'Old')).toThrow(/not supported/);
    expect(() => asyncApiImport({ asyncapi: '3.0.0', channels: {} }, 'col', 'Empty')).toThrow(/No channels/);
  });

  it('builds one MQTT session from an AsyncAPI 2 document', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'Streetlights', description: 'Turn streetlights on and off.' },
      servers: {
        production: { url: 'mqtt://broker.example.com:1883', protocol: 'mqtt', protocolVersion: '3.1.1', security: [{ user: [] }], bindings: { mqtt: { clientId: 'lights-console', cleanSession: false, keepAlive: 30, lastWill: { topic: 'lights/console/status', qos: 1, message: 'offline', retain: true } } } },
        test: { url: 'test.mosquitto.org:8883', protocol: 'secure-mqtt' },
      },
      channels: {
        'light/{streetlightId}/measured': {
          parameters: { streetlightId: { schema: { type: 'string', examples: ['42'] }, description: 'Streetlight id' } },
          subscribe: { operationId: 'receiveLightMeasurement', summary: 'Lighting measured', bindings: { mqtt: { qos: 1 } }, message: { name: 'LightMeasured', payload: { type: 'object', properties: { lumens: { type: 'integer', example: 3 } } } } },
        },
        'light/{streetlightId}/turn/on': {
          parameters: { streetlightId: { schema: { type: 'string', examples: ['42'] } } },
          publish: { operationId: 'turnOn', bindings: { mqtt: { qos: 2, retain: true } }, message: { name: 'TurnOn', payload: { type: 'object', properties: { command: { type: 'string', enum: ['on'] } } } } },
        },
      },
      components: { securitySchemes: { user: { type: 'userPassword' } } },
    };
    const { requests, variables } = asyncApiImport(spec, 'col', 'Streetlights');
    expect(requests).toHaveLength(1);
    const [session] = requests;
    expect(session).toMatchObject({ name: 'Streetlights', requestType: 'mqtt', url: '{{mqttBroker}}', folderPath: [], bodyContent: '{\n  "command": "on"\n}' });
    expect(session.auth).toMatchObject({ type: 'basic', basicUser: '{{mqttUsername}}', basicPass: '{{mqttPassword}}' });
    expect(session.mqtt).toMatchObject({
      version: '3.1.1', clientId: 'lights-console', cleanSession: false, keepAliveSec: 30,
      topic: 'light/{{streetlightId}}/turn/on', qos: 2, retain: true, format: 'json',
      topics: [{ name: 'light/+/measured', qos: 1, enabled: true, description: 'Lighting measured' }],
      will: { enabled: true, topic: 'lights/console/status', payload: 'offline', qos: 1, retain: true },
    });
    expect(session.mqtt?.savedMessages.map(message => [message.name, message.topic, message.qos, message.retain])).toEqual([['turnOn', 'light/{{streetlightId}}/turn/on', 2, true]]);
    expect(session.requestNotes).toContain('Subscribe light/+/measured: Lighting measured');
    expect(variables.map(row => [row.key, row.value, row.enabled])).toEqual([
      ['mqttBroker', 'mqtt://broker.example.com:1883', true],
      ['mqttBroker', 'mqtts://test.mosquitto.org:8883', false],
      ['mqttUsername', '', true],
      ['mqttPassword', '', true],
      ['streetlightId', '42', true],
    ]);
  });

  it('reads MQTT 5 servers and AsyncAPI 3 operations', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'Thermostats' },
      servers: { cloud: { host: 'iot.example.com', pathname: '/mqtt', protocol: 'wss', protocolVersion: '5.0' } },
      channels: {
        setpoint: { address: 'home/{room}/setpoint', parameters: { room: { default: 'kitchen' } }, messages: { a: { name: 'Setpoint', payload: { type: 'object', properties: { celsius: { type: 'number', example: 21 } } } }, b: { name: 'Reset', contentType: 'text/plain', payload: { type: 'string', example: 'reset' } } } },
        reading: { address: 'home/{room}/temperature', messages: { t: { name: 'Temperature', payload: { type: 'number' } } } },
      },
      operations: {
        setTemperature: { action: 'receive', title: 'Set the temperature', channel: { $ref: '#/channels/setpoint' } },
        readTemperature: { action: 'send', channel: { $ref: '#/channels/reading' }, bindings: { mqtt: { qos: 2 } } },
      },
    };
    const [session] = asyncApiImport(spec, 'col', 'Thermostats').requests;
    expect(session.mqtt).toMatchObject({ version: '5', topics: [{ name: 'home/+/temperature', qos: 2, enabled: true }] });
    expect(session.mqtt?.savedMessages.map(message => [message.name, message.format, message.payload])).toEqual([
      ['Set the temperature · Setpoint', 'json', '{\n  "celsius": 21\n}'],
      ['Set the temperature · Reset', 'text', 'reset'],
    ]);
    expect(asyncApiImport(spec, 'col', 'Thermostats').variables.map(row => [row.key, row.value])).toEqual([['mqttBroker', 'wss://iot.example.com/mqtt'], ['room', 'kitchen']]);
  });

  it('splits a document with Kafka and MQTT servers by the servers of each channel', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'Factory' },
      servers: { kafka: { host: 'kafka:9092', protocol: 'kafka' }, mqtt: { host: 'mqtt:1883', protocol: 'mqtt' } },
      channels: {
        events: { address: 'factory.events', servers: [{ $ref: '#/servers/kafka' }] },
        sensors: { address: 'sensors/{id}', servers: [{ $ref: '#/servers/mqtt' }] },
      },
      operations: {
        emit: { action: 'send', channel: { $ref: '#/channels/events' } },
        readSensors: { action: 'send', channel: { $ref: '#/channels/sensors' } },
      },
    };
    const { requests, variables } = asyncApiImport(spec, 'col', 'Factory');
    expect(requests.map(request => [request.requestType, request.name])).toEqual([['kafka', 'emit'], ['mqtt', 'MQTT session']]);
    expect(requests[1].mqtt?.topics.map(topic => topic.name)).toEqual(['sensors/+']);
    expect(variables.map(row => row.key)).toEqual(['brokers', 'mqttBroker']);
  });

  it('points each Kafka request at the cluster its channel names', () => {
    const spec = {
      asyncapi: '3.0.0',
      info: { title: 'Clusters' },
      servers: {
        east: { host: 'east:9092', protocol: 'kafka' },
        west: { host: 'west:9093', protocol: 'kafka-secure' },
      },
      channels: {
        orders: { address: 'orders', servers: [{ $ref: '#/servers/east' }] },
        payments: { address: 'payments', servers: [{ $ref: '#/servers/west' }] },
      },
      operations: {
        placeOrder: { action: 'send', channel: { $ref: '#/channels/orders' } },
        pay: { action: 'send', channel: { $ref: '#/channels/payments' } },
      },
    };
    const { requests, variables } = asyncApiImport(spec, 'col', 'Clusters');
    expect(requests.map(request => [request.name, request.url, request.kafka?.tls])).toEqual([
      ['placeOrder', '{{brokers_east}}', false],
      ['pay', '{{brokers_west}}', true],
    ]);
    expect(variables.filter(row => row.key.startsWith('brokers_')).map(row => [row.key, row.value, row.enabled])).toEqual([
      ['brokers_east', 'east:9092', true],
      ['brokers_west', 'west:9093', true],
    ]);
  });

  it('chooses MQTT from bindings when the document lists no servers', () => {
    const spec = { asyncapi: '2.6.0', info: { title: 'Bare' }, channels: { 'a/b': { subscribe: { bindings: { mqtt: { qos: 1 } }, message: { payload: { type: 'string' } } } } } };
    const [request] = asyncApiImport(spec, 'col', 'Bare').requests;
    expect(request.requestType).toBe('mqtt');
    expect(request.mqtt?.topics).toEqual([{ name: 'a/b', qos: 1, enabled: true, description: 'subscribe a/b' }]);
  });
});
