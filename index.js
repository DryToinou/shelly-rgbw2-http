// ISC License - Copyright 2018, Sander van Woensel
// TODO: colorsys usage?
//       enable coverage measurement.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const PACKAGE_JSON = require('./package.json');
const MANUFACTURER = PACKAGE_JSON.author.name;
const SERIAL_NUMBER = '001';
const MODEL = PACKAGE_JSON.name;
const FIRMWARE_REVISION = PACKAGE_JSON.version;

const IDENTIFY_BLINK_DELAY_MS = 250; // [ms]
const DEFAULT_BRIGHTNESS_MAX = 100;
const REQUEST_DELAY = 200;

// -----------------------------------------------------------------------------
// Module variables
// -----------------------------------------------------------------------------
var Service, Characteristic;
var request = require('request');
var api;
var convert = require('color-convert');

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------


//! @module homebridge
//! @param {object} homebridge Export functions required to create a
//!    new instance of this plugin.
module.exports = function(homebridge){
    api = homebridge;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(MODEL, 'homebridge-http-rgbw2', HttpPushRgb);
};

// -----------------------------------------------------------------------------
// Module functions
// -----------------------------------------------------------------------------

/**
 * Parse the config and instantiate the object.
 *
 * @constructor
 * @param {function} log Logging function.
 * @param {object} config The configuration object.
 */
function HttpPushRgb(log, config) {

    this.log = log;

    this.service                       = null;
    this.name                          = config.name                      || 'RGB Light';

    this.http_method                   = 'GET';
    this.timeout                       = config.timeout                   || 10000;
    this.mainurl                       = config.adress + '/color/0';

    // Handle the basic on/off
    // Register notification server.
    api.on('didFinishLaunching', function() {
        // Check if notificationRegistration is set and user specified notificationID.
        // if not 'notificationRegistration' is probably not installed on the system.
        if (global.notificationRegistration && typeof global.notificationRegistration === "function" &&
            config.switch.notificationID) {
            try {
               global.notificationRegistration(config.switch.notificationID, this.handleNotification.bind(this), config.switch.notificationPassword);

            } catch (error) {
                // notificationID is already taken.
            }
        }
    }.bind(this));

    // Local caching of HSB color space for RGB callback
    this.cache = {};
    this.cacheUpdated = false;

    this.cache.brightness = 100;
    this.cache.hue = 0;
    this.cache.saturation = 0;
    this.cache.ison = false;

    this.cache.lastUpdate = 0;
    this.cache.lastState = 0;

}

/**
 * @augments HttpPushRgb
 */
HttpPushRgb.prototype = {

    // Required Functions

    /**
     * Blink device to allow user to identify its location.
     */
    identify: function(callback) {
        this.log('Identify requested!');

        this.getPowerState( (error, onState) => {

           // eslint-disable-next-line no-unused-vars
           this.setPowerState(!onState, (error, responseBody) => {
               // Ignore any possible error, just continue as if nothing happened.
               setTimeout(() => {
                  this.setPowerState(onState, callback);
               }, IDENTIFY_BLINK_DELAY_MS);
           });
        });
    },

    getServices: function() {
        var informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
            .setCharacteristic(Characteristic.SerialNumber, SERIAL_NUMBER)
            .setCharacteristic(Characteristic.Model, MODEL)
            .setCharacteristic(Characteristic.FirmwareRevision, FIRMWARE_REVISION);

        this.log('Creating Lightbulb');
        this.service = new Service.Lightbulb(this.name);

        this.service
            .getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));

        this.log('... adding brightness');
        this.service
            .addCharacteristic(new Characteristic.Brightness())
            .on('get', this.getBrightness.bind(this))
            .on('set', this.setBrightness.bind(this));

        this.log('... adding color');
        this.service
            .addCharacteristic(new Characteristic.Hue())
            .on('get', this.getHue.bind(this))
            .on('set', this.setHue.bind(this));

        this.service
            .addCharacteristic(new Characteristic.Saturation())
            .on('get', this.getSaturation.bind(this))
            .on('set', this.setSaturation.bind(this));

        return [informationService, this.service];
    },

   //** Custom Functions **//

   /**
     * Called by homebridge-http-notification-server
     * whenever an accessory sends a status update.
     *
     * @param {function} jsonRequest The characteristic and characteristic value to update.
     */
   handleNotification: function (jsonRequest) {
        const characteristic = jsonRequest.characteristic;
        const value = jsonRequest.value;

        let characteristicType;
        switch (characteristic) {
            case "On":
                characteristicType = Characteristic.On;
                break;
            default:
                this.log("Encountered unknown characteristic when handling notification: " + jsonRequest.characteristic);
                return;
        }

        this.ignoreNextSetPowerState = true; // See method setPowerStatus().
        this.service.setCharacteristic(characteristicType, value); // This will also call setPowerStatus() indirectly.
    },

    /**
     * Gets power state of lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    getPowerState: function(callback) {
        _globalStateRequest(() => {callback(null, this.cache.ison)});
    },

    /**
     * Sets the power state of the lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    setPowerState: function(state, callback) {
        this._globalUpdateRequest(state,undefined,undefined,undefined,callback);
    },

    /**
     * Gets brightness of lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    getBrightness: function(callback) {
        _globalStateRequest(() => {callback(null, this.cache.brightness)});
    },

    /**
     * Sets the brightness of the lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    setBrightness: function(level /*NUMBER BETWEEN 0 & 100 */ , callback) {
        this._globalUpdateRequest(undefined,undefined,undefined,level,callback);
    },

    /**
     * Gets the hue of lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    getHue: function(callback) {
        _globalStateRequest(() => {callback(null, this.cache.hue)});
    },

    /**
     * Sets the hue of the lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    setHue: function(level /* NUMBER BETWEEN 0 & 360 */, callback) {
        this._globalUpdateRequest(undefined,level,undefined,undefined,callback);
    },

    /**
     * Gets the saturation of lightbulb.
     *
     * @param {function} callback The callback that handles the response.
     */
    getSaturation: function(callback) {
        _globalStateRequest(() => {callback(null, this.cache.saturation)});
    },

    /**
     * Sets the saturation of the lightbulb.
     *
     * @param {number} level The saturation of the new call.
     * @param {function} callback The callback that handles the response.
     */
    setSaturation: function(level /* number 0 & 100 */, callback) {
        this._globalUpdateRequest(undefined,undefined,level,undefined,callback);
    },

    /**
     * Sets the RGB value of the device based on the cached HSB values.
     *
     * @param {function} callback The callback that handles the response.
     */
    _setRGB: function(callback) {
        var rgbRequest = this._buildRgbRequest();
        this.cacheUpdated = false;

        this._httpRequest(rgbRequest.url, rgbRequest.body, this.color.http_method, function(error, response, responseBody) {
            if (!this._handleHttpErrorResponse('_setRGB()', error, response, responseBody, callback)) {
                this.log('... _setRGB() successfully set');
                callback();
            }
        }.bind(this));
    },

    _buildRgbRequest: function() {
        var rgb = convert.hsv.rgb([this.cache.hue, this.cache.saturation, this.cache.brightness]);
        var xyz = convert.rgb.xyz(rgb);
        var hex = convert.rgb.hex(rgb);

        if(xyz == null || xyz.size == 0) {
           this.log.error("Failed to convert HSB to xyz values. Cached values: H:%s S:%s B:%s", this.cache.hue, this.cache.saturation, this.cache.brightness);
           return {url: '', body: ''};
        }

        var xy = {
            x: (xyz[0] / 100 / (xyz[0] / 100 + xyz[1] / 100 + xyz[2] / 100)).toFixed(4),
            y: (xyz[1] / 100 / (xyz[0] / 100 + xyz[1] / 100 + xyz[2] / 100)).toFixed(4)
        };

        var url = this.color.set_url.url;
        var body = this.color.set_url.body;
        var replaces = {
            '%s': hex,
            '%xy-x': xy.x,
            '%xy-y': xy.y
        };
        for (var key in replaces) {
            url = url.replace(key, replaces[key]);
            body = body.replace(key, replaces[key]);
        }

        this.log('_buildRgbRequest converting H:%s S:%s B:%s to RGB:%s ...', this.cache.hue, this.cache.saturation, this.cache.brightness, hex);

        return {url: url, body: body};
    },


    // Utility Functions

    /**
     * Perform an HTTP request.
     *
     * @param {string} url URL to call.
     * @param {string} body Body to send.
     * @param {method} method Method to use.
     * @param {function} callback The callback that handles the response.
     */
    _httpRequest: function(url, body, method, callback) {
        request({
            url: url,
            body: body,
            method: method,
            timeout: this.timeout,
            rejectUnauthorized: false,
            auth: {
                user: this.username,
                pass: this.password
            }},
            function(error, response, body) {
               callback(error, response, body);
        });
    },

    /**
     * 
     * @param {function} callback 
     */

    _globalStateRequest: function(callback){
        if(this.cache.lastState != 0){
            
            if((Date.now() - this.cache.lastState) > 50){
                this.cache.lastState = 0;
            }

            callback();
        }else{
            this.cache.lastState = Date.now();

            //prepare request here
            request({
                url: this.mainurl,
                body: '',
                method: 'GET',
                timeout: this.timeout,
                rejectUnauthorized: false,
                function(error, response, body) {
                    var rspJsn = JSON.parse(response);
                    /*
                    rspJsn.red
                    rspJsn.green
                    rspJsn.blue
                    rspJsn.gain
                    rspJsn.ison
                    */
                    var hslRsp = this._rgbToHsl(rspJsn.red,rspJsn.green,rspJsn.blue);
                    this.cache.brightness = rspJsn.gain;
                    this.cache.hue = hslRsp[0];
                    this.cache.saturation = hslRsp[1];
                    this.cache.ison = (rspJsn.ison == 'on');

                    callback();
                }
            });
        }
    },

    /**
     * 
     * @param {bool} status 
     * @param {number} hue 
     * @param {number} saturation 
     * @param {number} brightness 
     * @param {function} callback 
     */

    _globalUpdateRequest: function(status,hue,saturation,brightness,callback) {
        if(status != undefined){
            this.cache.ison = status;
        }
        if(hue != undefined){
            this.cache.hue = hue;
        }
        if(saturation != undefined){
            this.cache.saturation = saturation;
        }
        if(brightness != undefined){
            this.cache.brightness = brightness;
        }
        
        if(this.cache.lastUpdate == 0){
            //no update yet, one in 50ms
            setTimeout(() => {
                //convert to rgb
                var rgb = convert.hsv.rgb([this.cache.hue, this.cache.saturation, 100]);
                request({
                    url: this.mainurl+'?turn='+(this.cache.ison ? 'on' : 'off')+'&gain='+this.cache.brightness+'&red='+rgb[0]+'&green='+rgb[1]+'&blue='+rgb[2],
                    body: '',
                    method: 'GET',
                    timeout: this.timeout,
                    rejectUnauthorized: false,
                    function(error, response, body) {
                        var rspJsn = JSON.parse(response);
                        var hslRsp = this._rgbToHsl(rspJsn.red,rspJsn.green,rspJsn.blue);
                        this.cache.brightness = rspJsn.gain;
                        this.cache.hue = hslRsp[0];
                        this.cache.saturation = hslRsp[1];
                        this.cache.ison = (rspJsn.ison == 'on');
    
                        callback();
                    }
                });
            },50);
        }else{
            //an update is ongoing, no need to update
            callback();
        }
    },

    /**
     * Verify if response code equals '200', otherwise log error and callback
     * with a new Error object.
     * @param  {String}   functionStr Description used to create log and error message.
     * @param  {Object}   error       Received error from client.
     * @param  {Object}   response    Received reponse from client.
     * @param  {Function} callback    Reply function to call when error ocurred.
     * @return {Boolean}              true: Error occurred, false otherwise
     */
    _handleHttpErrorResponse: function(functionStr, error, response, responseBody, callback) {
      var errorOccurred = false;
      if (error) {
          this.log(functionStr +' failed: %s', error.message);
          callback(error);
          errorOccurred = true;
      } else if (response.statusCode != 200) {
         this.log(functionStr + ' returned HTTP error code: %s: "%s"', response.statusCode, responseBody);
         callback( new Error("Received HTTP error code " + response.statusCode + ': "' + responseBody + '"') );
         errorOccurred = true;
      }
      return errorOccurred;
   },

    /**
     * Converts an RGB color value to HSL. Conversion formula
     * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
     * Assumes r, g, and b are in [0..255] and
     * returns h in [0..360], and s and l in [0..100].
     *
     * @param   {Number}  r       The red color value
     * @param   {Number}  g       The green color value
     * @param   {Number}  b       The blue color value
     * @return  {Array}           The HSL representation
     */
    _rgbToHsl: function(r, g, b){
        r /= 255;
        g /= 255;
        b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, l = (max + min) / 2;

        if(max == min){
            h = s = 0; // achromatic
        }else{
            var d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch(max){
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }

        h *= 360; // return degrees [0..360]
        s *= 100; // return percent [0..100]
        l *= 100; // return percent [0..100]
        return [parseInt(h), parseInt(s), parseInt(l)];
    },

};
