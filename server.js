var fs = require('fs'),
    execFile = require('child_process').execFile,
    express = require('express'),
    logger = require('morgan'),
    request = require('request'),
    _ = require('underscore'),
    temp = require('temp'),
    async = require('async'),
    mime = require('mime-types'),
    config = require('./config'),
    app = express(),
    basePath = config.basePath,
    convertArguments = config.convertCommand.split(/\s+/),
    convertCommand = convertArguments.shift(),
    port = config.port,
    convertTimeout = config.convertTimeout * 1000,
    concurrency = config.concurrency || 1,
    maxDimension = config.maxDimension,
    allowedTypes = [
//        'application/pdf',
        'image/jpeg',
        'image/png'
    ],
    convertQueue;

if (config.proxy) {
    console.log('using proxy', config.proxy);
    request = request.defaults({proxy: config.proxy});
}

convertQueue = async.queue(doConversion, concurrency);

app.use(logger('combined'));
app.get(/^(\/.+)\.([^.\/]+)(\.[^.\/]+)$/i, function (req, res) {
    var convertOptions = getConvertOptions(req.params[1]),
        source = basePath + req.params[0] + req.params[2],
        mimeType = mime.lookup(req.params[2]),
        times = {start: Date.now()},
        r;
    if (!convertOptions || allowedTypes.indexOf(mimeType) == -1) {
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
            fileExtension = mime.extension(mimeType),
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
            rawFile = getTempFilename('raw', fileExtension);
            convertedFile = getTempFilename('converted', fileExtension);
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
    var width = '',
        height = '',
        options = [],
        m, name, value, largerWidth, largerHeight;
    while (m = optionsString.match(/^([whr])(\d+)|^c(\d+x\d+\+\d+\+\d+)/)) {
        if (m[1]) {
            name = m[1];
            value = +m[2];
            switch (name) {
                case 'r':
                    if (value) { // Don't bother with rotate if 0
                        options.push('-rotate', value);
                    }
                    break;
                case 'w':
                    width = value;
                    break;
                case 'h':
                    height = value;
            }
        }
        else {
            options.push('-crop', m[3]);
        }
        optionsString = optionsString.substr(m[0].length);
    }
    if (optionsString) {
        return null;
    }
    if (width || height) {
        if (width && width > maxDimension) {
            width = maxDimension;
        }
        if (height && height > maxDimension) {
            height = maxDimension;
        }
        options.push('-resize', width + 'x' + height);
        // Add -size option at beginning to speed up conversion, following
        // http://sourceforge.net/mailarchive/message.php?msg_id=24752385
        largerWidth = width ? width * 2 : '';
        largerHeight = height ? height * 2 : '';
        if (largerHeight && largerHeight < maxDimension && largerWidth && largerWidth < maxDimension) {
            options.unshift('-size', largerWidth + 'x' + largerHeight);
        }
    }
    options.push('+profile', '*'); // remove Exif/IPTC/etc. metadata to avoid rotation issues
    return options;
}

function getTempFilename(namePart, fileExtension) {
    return temp.path({
        prefix: 'thumbnail-' + namePart + '-',
        dir: config.tempDir,
        suffix: '.' + fileExtension
    });
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
