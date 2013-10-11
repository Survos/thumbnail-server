var path = require('path'),
    nconf = require('nconf');

nconf.file('local', {file: path.join(__dirname, 'local.json')})
    .file('defaults', {file: path.join(__dirname, 'defaults.json')});

module.exports = nconf.get(); // whole config object
