var fs = require('fs'),
    execFile = require('child_process').execFile,
    express = require('express'),
    request = require('request'),
    _ = require('underscore'),
    temp = require('temp'),
    config = require('./config'),
    app = express(),
    basePath = config.basePath,
    convertArguments = config.convertCommand.split(/\s+/),
    convertCommand = convertArguments.shift(),
    port = config.port;

if (config.proxy) {
    console.log('using proxy', config.proxy);
    request = request.defaults({proxy: config.proxy});
}

app.use(express.logger());
app.get(/^(\/.+)\.([^.\/]+)(\.jpe?g)$/i, function (req, res) {
    var convertOptions = getConvertOptions(req.params[1]),
        relativePath = req.params[0] + req.params[2],
        source = basePath + relativePath,
        times = {start: Date.now()},
        r;
    if (!convertOptions) {
        res.send(400);
        return;
    }
    r = request(source);
    r.on('response', function (remoteRes) {
        var maxAge, m, rawFile, convertedFile, stream;
        if (remoteRes.statusCode === 200) {
            if (m = remoteRes.headers['cache-control'] && remoteRes.headers['cache-control'].match(/\bmax-age=(\d+)\b/)) {
                maxAge = m[1];
            }
            else {
                maxAge = config.maxAge;
            }
            rawFile = getTempFilename('raw');
            convertedFile = getTempFilename('converted');
            r.pipe(fs.createWriteStream(rawFile))
                .on('error', function (err) {
                    console.log('stream error', err);
                    res.send(500);
                    cleanup();
                })
                .on('finish', function () {
                    var args = convertArguments.concat(rawFile, convertOptions, convertedFile);
                    times.downloaded = Date.now();
                    console.log('%s written', rawFile);
                    console.log(convertCommand, args.join(' '));
                    execFile(convertCommand, args, function (err, stdout, stderr) {
                        if (err) {
                            console.log('convert error', err, stderr);
                            res.send(500);
                            cleanup();
                            return;
                        }
                        times.converted = Date.now();
                        console.log('sending converted file with max age', maxAge);
                        // sendfile() wants maxAge in milliseconds, not seconds:
                        res.sendfile(convertedFile, {maxAge: maxAge * 1000}, function () {
                            var prevTime;
                            times.sent = Date.now();
                            _.each(times, function (t, name) {
                                if (prevTime) {
                                    console.log('%s: %d', name, t - prevTime);
                                }
                                prevTime = t;
                            });
                            cleanup();
                        });
                    });
                });
        }
        else {
            console.log('HTTP error', remoteRes.statusCode);
            res.send(404);
        }
        function cleanup() {
            console.log('deleting', rawFile);
            fs.unlink(rawFile);
            if (convertedFile) {
                console.log('deleting', convertedFile);
                fs.unlink(convertedFile);
            }
        }
    });
    r.on('error', function (err) {
        console.log('request error', err);
        res.send(500);
    });
});

function getConvertOptions(optionsString) {
    var params = {w: '', h: ''},
        options = [],
        m;
    while (m = optionsString.match(/^([whr])(\d+)|^(c)(\d+x\d+\+\d+\+\d+)/)) {
        if (m[1]) {
            params[m[1]] = m[2];
        }
        else {
            params[m[3]] = m[4];
        }
        optionsString = optionsString.substr(m[0].length);
    }
    if (optionsString) {
        return null;
    }
    // Order of handling is important here
    if (params.c) {
        options.push('-crop', params.c);
    }
    if (params.r) {
        options.push('-rotate', params.r);
    }
    if (params.w || params.h) {
        options.push('-resize', params.w + 'x' + params.h);
    }
    options.push('+profile', '*'); // remove Exif/IPTC/etc. metadata to avoid rotation issues
    return options;
}

function getTempFilename(options) {
    if (typeof options == 'string') {
        options = {prefix: 'thumbnail-' + options + '-'};
    }
    _.defaults(options, {dir: config.tempDir, suffix: '.jpg'});
    return temp.path(options);
}

app.listen(port);
console.log('listening on port', port);

if (process.getuid() === 0) {
    // If run as root (to use privileged port) then change to less privileged user
    process.setgid(config.group);
    process.setuid(config.user);
}
