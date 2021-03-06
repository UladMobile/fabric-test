/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

var fs = require('fs-extra');
var hfc = require('fabric-client');
var FabricCAServices = require('fabric-ca-client');
var jsrsa = require('jsrsasign');
var os = require('os');
var path = require('path');
var util = require('util');
var winston = require('winston');

var KEYUTIL = jsrsa.KEYUTIL;


var copService = require('fabric-ca-client/lib/FabricCAServices.js');
var User = require('fabric-common/lib/User.js');
//var Constants = require('./constants.js');

// var logger = require('fabric-common/lib/Utils.js').getLogger('PTE util');

var PTEid = parseInt(process.argv[5]);
var loggerMsg='PTE ' + PTEid + ' util';
var logger = new PTELogger({"prefix":loggerMsg, "level":"info"});

module.exports.CHAINCODE_PATH = 'github.com/example_cc';
module.exports.CHAINCODE_UPGRADE_PATH = 'github.com/example_cc1';
module.exports.CHAINCODE_MARBLES_PATH = 'github.com/marbles_cc';
module.exports.END2END = {
	channel: 'mychannel',
	chaincodeId: 'end2end',
	chaincodeVersion: 'v0'
};


// directory for file based KeyValueStore
module.exports.KVS = '/tmp/hfc-test-kvs';
module.exports.storePathForOrg = function(networkid, org) {
	return module.exports.KVS + '_' + networkid + '_' + org;
};

// temporarily set $GOPATH to the test fixture folder
module.exports.setupChaincodeDeploy = function() {
	process.env.GOPATH = path.join(__dirname, '../fixtures');
};

// specifically set the values to defaults because they may have been overridden when
// running in the overall test bucket ('gulp test')
module.exports.resetDefaults = function() {
	global.hfc.config = undefined;
	require('nconf').reset();
};

module.exports.cleanupDir = function(keyValStorePath) {
	var absPath = path.resolve(process.cwd(), keyValStorePath);
	var exists = module.exports.existsSync(absPath);
	if (exists) {
		fs.removeSync(absPath);
	}
};

module.exports.getUniqueVersion = function(prefix) {
	if (!prefix) prefix = 'v';
	return prefix + Date.now();
};

// utility function to check if directory or file exists
// uses entire / absolute path from root
module.exports.existsSync = function(absolutePath /*string*/) {
	try  {
		var stat = fs.statSync(absolutePath);
		if (stat.isDirectory() || stat.isFile()) {
			return true;
		} else
			return false;
	}
	catch (e) {
		return false;
	}
};

module.exports.readFile = readFile;

var ORGS;
var goPath;

var	tlsOptions = {
	trustedRoots: [],
	verify: false
};

function getgoPath() {

        if ( typeof(ORGS.gopath) === 'undefined' ) {
            goPath = '';
        } else if ( ORGS.gopath == 'GOPATH' ) {
            goPath = process.env['GOPATH'];
        } else {
            goPath = ORGS.gopath;
        }
}

function getMember(username, password, client, nid, userOrg, svcFile) {
	hfc.addConfigFile(svcFile);
	ORGS = hfc.getConfigSetting('test-network');

	var caUrl = ORGS[userOrg].ca.url;

	logger.info('[getMember] getMember, name: '+username+', client.getUserContext('+username+', true)');

	return client.getUserContext(username, true)
	.then((user) => {
		return new Promise((resolve, reject) => {
			if (user && user.isEnrolled()) {
				logger.info('[getMember] Successfully loaded member from persistence');
				return resolve(user);
			}

			var member = new User(username);
			var cryptoSuite = client.getCryptoSuite();
                        if (!cryptoSuite) {
			    cryptoSuite = hfc.newCryptoSuite();
			    if (userOrg) {
				cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: module.exports.storePathForOrg(nid, ORGS[userOrg].name)}));
				client.setCryptoSuite(cryptoSuite);
			    }
			}
			member.setCryptoSuite(cryptoSuite);

			// need to enroll it with CA server
			var cop = new copService(caUrl, tlsOptions, ORGS[userOrg].ca.name, cryptoSuite);

			return cop.enroll({
				enrollmentID: username,
				enrollmentSecret: password
			}).then((enrollment) => {
				logger.info('[getMember] Successfully enrolled user \'' + username + '\'');

				return member.setEnrollment(enrollment.key, enrollment.certificate, ORGS[userOrg].mspid);
			}).then(() => {
                                var skipPersistence = false;
                                if (!client.getStateStore()) {
                                    skipPersistence = true;
                                }
				return client.setUserContext(member, skipPersistence);
			}).then(() => {
				return resolve(member);
			}).catch((err) => {
				logger.error('[getMember] Failed to enroll and persist user. Error: ' + err.stack ? err.stack : err);
			});
		});
	});
}

function getAdmin(client, nid, userOrg, svcFile) {
        hfc.addConfigFile(svcFile);
        ORGS = hfc.getConfigSetting('test-network');
        var keyPath;
        var keyPEM;
        var certPath;
        var certPEM;

        if (typeof ORGS[userOrg].admin_cert !== 'undefined') {
            logger.info(' %s admin_cert defined', userOrg);
            keyPEM = ORGS[userOrg].priv;
            certPEM = ORGS[userOrg].admin_cert;
        } else {
            getgoPath();
            logger.info(' %s admin_cert undefined', userOrg);
            keyPath =  path.resolve(goPath, ORGS[userOrg].adminPath , 'keystore');
            keyPEM = Buffer.from(readAllFiles(keyPath)[0]).toString();
            certPath = path.resolve(goPath, ORGS[userOrg].adminPath, 'signcerts');
            certPEM = readAllFiles(certPath)[0];
            logger.debug('[getAdmin] keyPath: %s', keyPath);
            logger.debug('[getAdmin] certPath: %s', certPath);
        }

        var cryptoSuite = hfc.newCryptoSuite();
	if (userOrg) {
                cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({path: module.exports.storePathForOrg(nid, ORGS[userOrg].name)}));
                client.setCryptoSuite(cryptoSuite);
	}

	return Promise.resolve(client.createUser({
		username: 'peer'+userOrg+'Admin',
		mspid: ORGS[userOrg].mspid,
		cryptoContent: {
			privateKeyPEM: keyPEM.toString(),
			signedCertPEM: certPEM.toString()
		}
	}));
}

function getOrdererAdmin(client, userOrg, svcFile) {
        hfc.addConfigFile(svcFile);
        ORGS = hfc.getConfigSetting('test-network');
        var keyPath;
        var keyPEM;
        var certPath;
        var certPEM;
        var ordererID = ORGS[userOrg].ordererID;

        if (typeof ORGS['orderer'].admin_cert !== 'undefined') {
            logger.info(' %s global orderer admin_cert defined', userOrg);
            keyPEM = ORGS['orderer'].priv;
            certPEM = ORGS['orderer'].admin_cert;
        } else if (typeof ORGS['orderer'][ordererID].admin_cert !== 'undefined') {
            logger.info(' %s local orderer admin_cert defined', userOrg);
            keyPEM = ORGS['orderer'][ordererID].priv;
            certPEM = ORGS['orderer'][ordererID].admin_cert;
        } else if (typeof ORGS['orderer'].adminPath !== 'undefined') {
            getgoPath();
            logger.info(' %s global orderer adminPath defined', userOrg);
            keyPath = path.resolve(goPath, ORGS['orderer'].adminPath, 'keystore');
            keyPEM = Buffer.from(readAllFiles(keyPath)[0]).toString();
            certPath = path.resolve(goPath, ORGS['orderer'].adminPath, 'signcerts');
            certPEM = readAllFiles(certPath)[0];
            logger.debug('[getOrdererAdmin] keyPath: %s', keyPath);
            logger.debug('[getOrdererAdmin] certPath: %s', certPath);
        } else {
            getgoPath();
            logger.info(' %s local orderer adminPath defined', userOrg);
            keyPath = path.resolve(goPath, ORGS['orderer'][ordererID].adminPath, 'keystore');
            keyPEM = Buffer.from(readAllFiles(keyPath)[0]).toString();
            certPath = path.resolve(goPath, ORGS['orderer'][ordererID].adminPath, 'signcerts');
            certPEM = readAllFiles(certPath)[0];
            logger.debug('[getOrdererAdmin] keyPath: %s', keyPath);
            logger.debug('[getOrdererAdmin] certPath: %s', certPath);
        }

	return Promise.resolve(client.createUser({
		username: 'ordererAdmin',
		mspid: ORGS['orderer'][ordererID].mspid,
		cryptoContent: {
			privateKeyPEM: keyPEM.toString(),
			signedCertPEM: certPEM.toString()
		}
	}));
}

function readFile(path) {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (err, data) => {
			if (!!err)
				reject(new Error('Failed to read file ' + path + ' due to error: ' + err));
			else
				resolve(data);
		});
	});
}

function readAllFiles(dir) {
	var files = fs.readdirSync(dir);
	var certs = [];
	files.forEach((file_name) => {
		let file_path = path.resolve(dir,file_name);
		logger.debug('[readAllFiles] looking at file ::'+file_path);
		let data = fs.readFileSync(file_path);
		certs.push(data);
	});
	return certs;
}

module.exports.getOrderAdminSubmitter = function(client, userOrg, svcFile) {
	return getOrdererAdmin(client, userOrg, svcFile);
};

module.exports.getSubmitter = function(username, secret, client, peerOrgAdmin, nid, org, svcFile) {
	if (arguments.length < 2) throw new Error('"client" and "test" are both required parameters');

	var peerAdmin, userOrg;
	if (typeof peerOrgAdmin === 'boolean') {
		peerAdmin = peerOrgAdmin;
	} else {
		peerAdmin = false;
	}

	// if the 3rd argument was skipped
	if (typeof peerOrgAdmin === 'string') {
		userOrg = peerOrgAdmin;
	} else {
		if (typeof org === 'string') {
			userOrg = org;
		} else {
			userOrg = 'org1';
		}
	}

	if (peerAdmin) {
		logger.info(' >>>> getting the org admin');
		return getAdmin(client, nid, userOrg, svcFile);
	} else {
		return getMember(username, secret, client, nid, userOrg, svcFile);
	}
};

// set up PTE logger
function PTELogger(opts) {
    var winstonLogger = new winston.Logger({
        transports: [
            new (winston.transports.Console)({ colorize: true })
        ]
    }),
        levels = ['debug', 'info', 'warn', 'error'],
        logger = Object.assign({}, winstonLogger);

    if (opts.level) {
        if (levels.includes(opts.level)) {
            // why, oh why, does logger.level = opts.level not work?
            winstonLogger.level = opts.level;
        }
    }

    levels.forEach(function (method) {
        var func = winstonLogger[method];

        logger[method] = (function (context, tag, f) {
            return function () {
                if (arguments.length > 0) {
                    var timenow=new Date().toISOString();
                    var prefix = '[' + timenow + ' ' + tag + ']: ';
                    arguments[0] = prefix + arguments[0];
                }

                f.apply(context, arguments);
            };
        }(winstonLogger, opts.prefix, func));
    });

    return logger;
}
module.exports.PTELogger = PTELogger;

function getTLSCert(key, subkey) {

    var data;
    logger.info('[getTLSCert] key: %s, subkey: %s', key, subkey);
    ORGS = hfc.getConfigSetting('test-network');
    getgoPath();

    if ( typeof(ORGS.tls_cert) !== 'undefined' ) {
        data = ORGS.tls_cert;
    } else {
        var tlscerts = ORGS[key][subkey].tls_cacerts;
        if (tlscerts.includes('BEGIN CERTIFICATE')) {
           //tlscerts is a cert
           data = tlscerts;
        } else {
            var caRootsPath = path.resolve(goPath, ORGS[key][subkey].tls_cacerts);
            if (fs.existsSync(caRootsPath)) {
                //caRootsPath is a cert path
                data = fs.readFileSync(caRootsPath);
            } else {
                logger.info('[getTLSCert] tls_cacerts does not exist: caRootsPath: %s, key: %s, subkey: %s', caRootsPath, key, subkey);
                return null;
            }
        }
    }
    return data;
}
module.exports.getTLSCert = getTLSCert;

module.exports.tlsEnroll = async function(client, orgName, svcFile) {
    logger.info('[tlsEnroll] CA tls enroll: %s, svcFile: %s', orgName, svcFile);
    hfc.addConfigFile(svcFile);
    return new Promise(function (resolve, reject) {
        FabricCAServices.addConfigFile(svcFile);
        let orgs = FabricCAServices.getConfigSetting('test-network');
        if (!orgs[orgName]) {
                throw new Error('Invalid org name: ' + orgName);
        }
        let fabricCAEndpoint = orgs[orgName].ca.url;
        let tlsOptions = {
            trustedRoots: [],
            verify: false
        };
        let caService = new FabricCAServices(fabricCAEndpoint, tlsOptions, orgs[orgName].ca.name);
        logger.info('[tlsEnroll] CA tls enroll ca name: %j', orgs[orgName].ca.name);
        let req = {
            enrollmentID: 'admin',
            enrollmentSecret: 'adminpw',
            profile: 'tls'
        };
        caService.enroll(req).then(
            function(enrollment) {
                const key = enrollment.key.toBytes();
                const cert = enrollment.certificate;
                client.setTlsClientCertAndKey(cert, key);
                logger.info('[tlsEnroll] CA tls enroll succeeded');

                return resolve(enrollment);
            },
            function(err) {
                logger.info('[tlsEnroll] CA tls enroll failed: %j', err);
                return reject(err);
            }
        );
    });
}

var TLSDISABLED = 0;
var TLSSERVERAUTH = 1;
var TLSCLIENTAUTH = 2;
module.exports.TLSDISABLED = TLSDISABLED;
module.exports.TLSSERVERAUTH = TLSSERVERAUTH;
module.exports.TLSCLIENTAUTH = TLSCLIENTAUTH;

module.exports.setTLS=function(txCfgPtr) {
    var TLSin=txCfgPtr.TLS.toUpperCase();
    var TLS = TLSDISABLED;        // default
    if ( (TLSin == 'SERVERAUTH') || (TLSin == 'ENABLED') ) {
        TLS = TLSSERVERAUTH;
    } else if ( TLSin == 'CLIENTAUTH' ) {
       TLS = TLSCLIENTAUTH;
    }
    logger.info('[setTLS] TLSin: %s, TLS: %d', TLSin, TLS);

    return TLS;
}

// get ordererID for transactions
module.exports.getOrdererID=function(pid, orgName, org, txCfgPtr, svcFile, method) {
    hfc.addConfigFile(svcFile);
    ORGS = hfc.getConfigSetting('test-network');
    var ordererID;

    logger.info('[org:id=%s:%d getOrdererID] orderer method: %s', org, pid, method);
    // find ordererID
    if ( method == 'ROUNDROBIN' ) {
        // Round Robin
        var nProcPerOrg = parseInt(txCfgPtr.nProcPerOrg);
        var orgNameLen=orgName.length;
        var orgIdx=orgName.indexOf(org);
        var SCordList=Object.keys(ORGS.orderer);
        logger.info('[org:id=%s:%d getOrdererID] SC orderer list: %j', org, pid, SCordList);
        var ordLen=SCordList.length;

        var nOrderers=0;
        if ( txCfgPtr.ordererOpt && txCfgPtr.ordererOpt.nOrderers ) {
            nOrderers= parseInt(txCfgPtr.ordererOpt.nOrderers);
        }
        if ( nOrderers == 0 ) {
            nOrderers = ordLen;
        } else if ( ordLen < nOrderers ) {
            nOrderers = ordLen;
        }
        logger.info('[org:id=%s:%d getOrdererID] orderer orgNameLen %d, ordLen %d, nOrderers %d', org, pid, orgNameLen, ordLen, nOrderers);

        var ordIdx=(pid*orgNameLen+orgIdx)%nOrderers;
        ordererID=SCordList[ordIdx];
    } else {
        // default method: USERDEFINED
        ordererID = ORGS[org].ordererID;
    }

    logger.info('[org:id=%s:%d getOrdererID] orderer assigned to the test: %s', org, pid, ordererID);

    return ordererID;
}

// get peerID for transactions
module.exports.getPeerID=function(pid, org, txCfgPtr, svcFile, method) {
    hfc.addConfigFile(svcFile);
    ORGS = hfc.getConfigSetting('test-network');
    var peerID="UNKNOWN";

    logger.info('[org:id=%s:%d getPeerID] peer method: %s', org, pid, method);
    // find peerID
    if ( method == 'ROUNDROBIN' ) {
        // Round Robin
        var nProcPerOrg = parseInt(txCfgPtr.nProcPerOrg);
        var SCordList=[];
        for (var key in ORGS[org]) {
            if (ORGS[org][key].requests) {
                SCordList.push(key);
            }
        }
        logger.info('[org:id=%s:%d getPeerID] SC peer list: %j', org, pid, SCordList);
        logger.info('[org:id=%s:%d getPeerID] SC peer length: %j', org, pid, SCordList.length);
        var peerLen=SCordList.length;
        var peerIdx=(pid)%peerLen;
        peerID=SCordList[peerIdx];
    }

    logger.info('[org:id=%s:%d getPeerID] peer assigned to the test: %s %s', org, pid, org, peerID);

    return peerID;
}
