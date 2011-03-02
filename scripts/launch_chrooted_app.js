#!/usr/bin/env node
var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    Script = process.binding('evals').Script,
    Module = require('module');

var config = JSON.parse(fs.readFileSync(path.join('.nodester', 'config.json'), encoding='utf8'));

console.log(config);

//These 3 lines ensure that we get the daemon setup by the nodester user and not the
// one available to root, since we are sudoed at this point
require.paths.unshift(path.join(config.appdir, '../', '.node_libraries'));
require.paths.unshift('/.node_libraries');
var daemon = require('daemon');

var app_port = parseInt(config.port);
var app_host = config.ip;

console.log('chroot: ', config.apphome);
daemon.chroot(config.apphome);
console.log('Starting Daemon');
daemon.daemonize(path.join('.nodester', 'logs', 'daemon.log'), path.join('.nodester', 'pids', 'app.pid'), function(err, pid) {
	if (err) {
		console.log(err.stack);
	}
	console.log('Inside Daemon: ', pid);
	console.log('Changing to user: ', config.userid);
	daemon.setreuid(config.userid);
    console.log('User Changed: ', process.getuid());
    
    //Setup the errorlog
	var error_log_fd = fs.openSync('/error.log', 'w');
	process.on('uncaughtException', function (err) {
	    fs.write(error_log_fd, err.stack);
	});

    //Setup the main sandbox..
    var sandbox = {
        global: {},
        process: process,
        require: require,
        console: console,
        module: {},
        __filename: config.start,
        __dirname: "/",
        clearInterval: clearInterval,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        setTimeout: setTimeout
    };

    sandbox.module = new Module();
    sandbox.module.id = '.';
    sandbox.module.filename = '/' + config.start;
    sandbox.module.paths = ['/'];

    sandbox.process.pid = pid;
    sandbox.process.installPrefix = '/';
    sandbox.process.ARGV = ['node', config.start];
    sandbox.process.argv = sandbox.process.ARGV;
    sandbox.process.env = sandbox.process.ENV = {
      'app_port': app_port,
      'app_host': app_host
    };
    sandbox.process.mainModule = sandbox.module;
    sandbox.process.kill = function () { return 'process.kill is disabled' };
    sandbox.process.stdout.write = sandbox.console.warn = sandbox.console.error = function (args) {
      fs.write(error_log_fd, args.toString());
    };
    
    //this should make require('./lib/foo'); work properly
    var _require = require;
    var _resolve = require.resolve;
    sandbox.require = function(f) {
        if (f.indexOf('./') === 0) {
            //console.log('Nodester fixing require path', f); 
            f = f.substring(1);
            //console.log('Nodester fixed require path', f); 
        }   
        return _require.call(this, f); 
    };

    for (var i in _require) {
        sandbox.require[i] = _require[i];
    }   
    sandbox.require.resolve = function(f) {
        if (f.indexOf('./') === 0) {
            //console.log('Nodester fixing require path', f); 
            f = f.substring(1);
            //console.log('Nodester fixed require path', f); 
        }   
        return _resolve.call(this, f); 
    };   


    sandbox.require.main = sandbox.module;
    sandbox.require.cache = {};
    sandbox.require.cache['/' + config.start] = sandbox.module;
    sandbox.require.paths = ['/.node_libraries'];

    //Simple HTTP sandbox to make sure that http listens on the assigned port.
    //May also need to handle the net module too..
    var _http = require('http');
    var _create = _http.createServer;
    _http.createServer = function() {
        var h = _create.apply(this, arguments);
        var _listen = h.listen;
        h.listen = function(port) {
            console.log('[ERROR] You asked to listen on port', port, ' but nodester will use port', app_port, 'instead..');
            _listen.call(h, app_port);
        };
        return h;
    };

    sandbox.require.cache['http'] = {
        id: 'http',
        filename: 'override_http_module',
        loaded: false,
        exited: false,
        children: [],
        exports: _http
    };


    sandbox.process.on('uncaughtException', function (err) {
        fs.write(error_log_fd, util.inspect(err));
    });

    fs.readFile(config.start, function (err, script_src) {
        try {
            //Just to make sure the process is owned by the right users (overkill)
            process.setuid(config.userid);
            //console.log('Final user check (overkill)', process.getuid());
        } catch (err) {
            console.log(err.stack);
        }
        if (err) {
            console.log(err.stack);
            process.exit(1);
        } else {
            console.log('Nodester wrapped script starting (' + process.pid + ') at ', new Date());
            Script.runInNewContext(script_src, sandbox, config.start);
        }
    });
//End Daemon
});

