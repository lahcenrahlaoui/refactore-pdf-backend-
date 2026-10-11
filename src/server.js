// Local development only: `npm start`
const app = require('./app');
const { log } = require('./logger');

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => log(`PDF server listening on port ${PORT}`));