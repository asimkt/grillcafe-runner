import { handler, send, stats } from './_lib.js';
export default handler(['GET'], async (req, res) => { send(res, 200, await stats()); });
