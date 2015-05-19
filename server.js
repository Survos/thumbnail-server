var fs = require('fs'),
    execFile = require('child_process').execFile,
    express = require('express'),
    logger = require('morgan'),
    request = require('request'),
    _ = require('underscore'),
    temp = require('temp'),
    async = require('async'),
    config = require('./config'),
    app = express(),
    basePath = config.basePath,
    convertArguments = config.convertCommand.split(/\s+/),
    convertCommand = convertArguments.shift(),
    port = config.port,
    convertTimeout = config.convertTimeout * 1000,
    concurrency = config.concurrency || 1,
    maxDimension = config.maxDimension,
    convertQueue;

if (config.proxy) {
    console.log('using proxy', config.proxy);
    request = request.defaults({proxy: config.proxy});
}

convertQueue = async.queue(doConversion, concurrency);

app.use(logger('combined'));
app.get(/^(\/.+)\.([^.\/]+)(\.jpe?g)$/i, function (req, res) {
    var convertOptions = getConvertOptions(req.params[1]),
        relativePath = req.params[0] + req.params[2],
        source = basePath + relativePath,
        times = {start: Date.now()},
        r;
    if (!convertOptions) {
        res.sendStatus(400);
        return;
    }
    console.log('request headers', req.headers);
    // We're assuming files never change (kluge)
    if (req.headers['if-none-match'] || req.headers['if-modified-since']) {
        res.set('Cache-Control', 'max-age=' + config.maxAge) // @todo Handle this better
            .sendStatus(304);
        return;
    }
    r = request(source);
    r.on('response', function (remoteRes) {
        var sendOptions = {headers: {}},
            m, maxAge, rawFile, convertedFile, stream;
        if (remoteRes.statusCode === 200) {
            if (m = remoteRes.headers['cache-control'] && remoteRes.headers['cache-control'].match(/\bmax-age=(\d+)\b/)) {
                maxAge = m[1] * 1000;
            }
            else {
                maxAge = config.maxAge;
            }
            sendOptions.headers['Cache-Control'] = 'max-age=' + maxAge;
            if (remoteRes.headers['last-modified']) {
                sendOptions.headers['Last-Modified'] = remoteRes.headers['last-modified'];
            }
            rawFile = getTempFilename('raw');
            convertedFile = getTempFilename('converted');
            r.pipe(fs.createWriteStream(rawFile))
                .on('error', function (err) {
                    console.log('stream error', err);
                    res.sendStatus(500);
                    cleanup();
                })
                .on('finish', function () {
                    var task = {
                            rawFile: rawFile,
                            convertOptions: convertOptions,
                            convertedFile: convertedFile,
                            times: times
                        };
                    times.downloaded = Date.now();
                    console.log('%s written', rawFile);
                    convertQueue.push(task, function (err) {
                        if (err) {
                            if (err == 'timeout') {
                                console.log('Giving up after waiting ', Date.now() - task.times.start);
                                res.sendStatus(503);
                            }
                            else {
                                res.sendStatus(500);
                            }
                            cleanup();
                            return;
                        }
                        times.converted = Date.now();
                        console.log('sending converted file with options', sendOptions);
                        res.sendFile(convertedFile, sendOptions, function () {
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
            res.sendStatus(404);
        }
        function cleanup() {
            console.log('deleting', rawFile);
            fs.unlink(rawFile, function () {});
            if (convertedFile) {
                console.log('deleting', convertedFile);
                fs.unlink(convertedFile, function () {});
            }
        }
    });
    r.on('error', function (err) {
        console.log('request error', err);
        res.sendStatus(500);
    });
});

function getConvertOptions(optionsString) {
    var params = {w: '', h: ''},
        options = [],
        m, largerWidth, largerHeight;
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
    if (params.r) {
        if (+params.r) { // Don't bother with rotate if 0
            options.push('-rotate', params.r);
        }
    }
    if (params.c) {
        options.push('-crop', params.c);
    }
    if (params.w || params.h) {
        if (params.w && params.w > maxDimension) {
            params.w = maxDimension;
        }
        if (params.h && params.h > maxDimension) {
            params.h = maxDimension;
        }
        options.push('-resize', params.w + 'x' + params.h);
        // Add -size option at beginning to speed up conversion, following
        // http://sourceforge.net/mailarchive/message.php?msg_id=24752385
        largerWidth = params.w ? params.w * 2 : '';
        largerHeight = params.h ? params.h * 2 : '';
        if (largerHeight && largerHeight < maxDimension && largerWidth && largerWidth < maxDimension) {
            options.unshift('-size', largerWidth + 'x' + largerHeight);
        }
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

function doConversion(task, callback) {
    if (task.times.start < Date.now() - 15000) {
        // It's been waiting too long
        setImmediate(function () { callback('timeout'); });
        return;
    }
    var args = task.convertOptions.slice(0), // clone
        inputFilePosition = args[0] === '-size' ? 2 : 0, // -size goes before input file
        execOptions = {timeout: convertTimeout};
    args.splice(inputFilePosition, 0, task.rawFile);
    args = convertArguments.concat(args, task.convertedFile);
    task.times.waiting = Date.now();
    console.log(convertCommand, args.join(' '));
    execFile(convertCommand, args, execOptions, function (err, stdout, stderr) {
        if (err) {
            console.log('convert error', err, stderr);
        }
        callback(err);
    });
}

app.listen(port);
console.log('listening on port', port);

if (process.getuid() === 0) {
    // If run as root (to use privileged port) then change to less privileged user
    process.setgid(config.group);
    process.setuid(config.user);
}
