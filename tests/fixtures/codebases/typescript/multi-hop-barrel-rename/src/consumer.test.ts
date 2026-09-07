import { Bus } from './impl';

const bus = new Bus();
const events = bus.getEvents();
console.log(events[0].id);
