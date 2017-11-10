var path = require('path'),
    nconf = require('nconf'),
    camelize = require('underscore.string/camelize'),
    keys = Object.keys(require('./defaults.json'));

nconf.argv()
    .env({
        parseValues: true,
        transform: function (obj) {
            obj.key = camelize(obj.key.toLowerCase());
            return keys.indexOf(obj.key) === -1 ? false : obj;
        }
    })
    .file('local', {file: path.join(__dirname, 'local.json')})
    .file('defaults', {file: path.join(__dirname, 'defaults.json')});

module.exports = nconf.get(); // whole config object
