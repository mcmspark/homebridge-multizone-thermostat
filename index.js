var http = require('http');
var gpio = require('rpi-gpio');
var BME280 = require('node-adafruit-bme280');

gpio.setMode(gpio.MODE_BCM);

var OFF = true;
var ON = false;

var Accessory, Service, Characteristic, CustomCharacteristic, UUIDGen, sensorData, zoneSensorMap;


zoneSensorMap={
  '1':{
        'AE' : {'location':'snug','source':'serial'},
        'AF' : {'location':'living','source':'serial'},
        'AH' : {'location':'ground','source':'serial'},
        'BM' : {'location':'pi','source':'I2C'}
      },
  '2':{
        'AA' : {'location':'master','source':'serial'},
        'AB' : {'location':'tess','source':'serial'},
        'AC' : {'location':'kate','source':'serial'}
      },
  '3':{
        'AD' : {'location':'addition','source':'serial'}
      }
};

sensorData={
  'AA':{'temp':0,'batt':0},
	'AB':{'temp':0,'batt':0},
	'AC':{'temp':0,'batt':0},
	'AD':{'temp':0,'batt':0},
	'AE':{'temp':0,'batt':0},
	'AF':{'temp':0,'batt':0},
	'BM':{'temp':0,'press':0,'humid':0},
	'AH':{'temp':0,'batt':0}
};

var zonecount=0;

function CustomCharacteristics(Characteristic) {
  this.AirPressure = function() {
    Characteristic.call(this, 'Air Pressure', 'E863F10F-079E-48FF-8F27-9C2605A29F52');
    this.setProps({
      format: Characteristic.Formats.FLOAT,
      unit: 'hectopascals',
      minValue: 700,
      maxValue: 1100,
      minStep: 1,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };
  this.AirPressure.prototype=Object.create(Characteristic.prototype);

  return this;
}

module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  CustomCharacteristic=CustomCharacteristics(Characteristic);
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform("homebridge-multizone-thermostat", "MultiZonePlatform", MultiZonePlatform, true);
};

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
function MultiZonePlatform(log, config, api) {
  log("MultiZonePlatform Init");
  var platform = this;
  this.log = log;
  this.config = config;
  
  this.sensorCheckMilliseconds=10000;
  
  this.accessories = [];

  this.requestServer = http.createServer(function(request, response) {
    if (request.url === "/temp") {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/json');
      response.end(JSON.stringify(temperatureData));
    }
  }.bind(this));

  this.requestServer.listen(3000, function() {
    platform.log("Server Listening...");
  });

  if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api;

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
      }.bind(this));
  }
  // add accessories for each zone
  var zone=1;
  this.addAccessory("Zone" + zone + " Thermostat", zone);
  this.startSensorLoops();
}

MultiZonePlatform.prototype.startSensorLoops=function(){
  this.sensorInterval=this.setInterval(this.readTemperatureFromI2C,this.sensorCheckMilliseconds);
};

MultiZonePlatform.prototype.getAccessoryForSensor=function(sensorName){
  for(var accessory in this.accessories){
    if(zoneSensorMap[accessory.zone][sensorName])return accessory;
  }  
  return undefined;
};

MultiZonePlatform.prototype.updateSensorData=function(sensorName, temperature, battery, pressure, humidity){
  //this is the global copy of all sensors for debugging
  sensorData[sensorName]={'temp':temperature-1.1111, 'batt': battery, 'press':pressure, 'humid':humidity};
  
  var accessory=this.getAccessoryForSensor(sensorName);
  if(accessory){
    accessory.sensorData[sensorName]={'temp':temperature-1.1111, 'batt': battery, 'press':pressure, 'humid':humidity};
    accessory.currentTemperature = temperature;
    accessory.currentPressure=pressure;
    accessory.currentRelativeHumidity = humidity;
    accessory.thermostatService.setCharacteristic(Characteristic.CurrentTemperature, accessory.getCurrentTemperature());
    if(pressure)accessory.thermostatService.setCharacteristic(CustomCharacteristic.AirPressure,accessory.currentPressure);
    if(humidity)accessory.thermostatService.setCharacteristic(Characteristic.CurrentRelativeHumidity, accessory.currentRelativeHumidity);
  }
};

MultiZonePlatform.prototype.readTemperatureFromI2C =function() {
    BME280.probe((temperature, pressure, humidity) => {
        sensorData['BM']={'temp':temperature-1.1111, 'press':pressure, 'humid':humidity};
        this.updateSensorData('BM', temperature-1.1111, null, pressure, humidity);
    });
};
// Function invoked when homebridge tries to restore cached accessory.
// Developer can configure accessory at here (like setup event handler).
// Update current value.
MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  this.log(accessory.displayName, "Configure Accessory");
  var platform = this;

  // Set the accessory to reachable if plugin can currently process the accessory,
  // otherwise set to false and update the reachability later by invoking 
  // accessory.updateReachability()
  accessory.reachable = true;

  accessory.on('identify', function(paired, callback) {
    platform.log(accessory.displayName, "Identify!!!");
    callback();
  });
/*
  if (accessory.getService(Service.Lightbulb)) {
    accessory.getService(Service.Lightbulb)
    .getCharacteristic(Characteristic.On)
    .on('set', function(value, callback) {
      platform.log(accessory.displayName, "Light -> " + value);
      callback();
    });
  }
*/
  //extend this service
  MakeThermostat(accessory);
  this.accessories.push(accessory);
};

// Handler will be invoked when user try to config your plugin.
// Callback can be cached and invoke when necessary.
MultiZonePlatform.prototype.configurationRequestHandler = function(context, request, callback) {
  this.log("Context: ", JSON.stringify(context));
  this.log("Request: ", JSON.stringify(request));

  // Check the request response
  if (request && request.response && request.response.inputs && request.response.inputs.name) {
    this.addAccessory(request.response.inputs.name);

    // Invoke callback with config will let homebridge save the new config into config.json
    // Callback = function(response, type, replace, config)
    // set "type" to platform if the plugin is trying to modify platforms section
    // set "replace" to true will let homebridge replace existing config in config.json
    // "config" is the data platform trying to save
    callback(null, "platform", true, {"platform":"MultiZonePlatform", "zoneSensorMap":zoneSensorMap});
    return;
  }

  // - UI Type: Input
  // Can be used to request input from user
  // User response can be retrieved from request.response.inputs next time
  // when configurationRequestHandler being invoked

  var respDict = {
    "type": "Interface",
    "interface": "input",
    "title": "Add Accessory",
    "items": [
      {
        "id": "name",
        "title": "Name",
        "placeholder": "Zone Thermostat"
      }//, 
      // {
      //   "id": "pw",
      //   "title": "Password",
      //   "secure": true
      // }
    ]
  };

  // - UI Type: List
  // Can be used to ask user to select something from the list
  // User response can be retrieved from request.response.selections next time
  // when configurationRequestHandler being invoked

  // var respDict = {
  //   "type": "Interface",
  //   "interface": "list",
  //   "title": "Select Something",
  //   "allowMultipleSelection": true,
  //   "items": [
  //     "A","B","C"
  //   ]
  // }

  // - UI Type: Instruction
  // Can be used to ask user to do something (other than text input)
  // Hero image is base64 encoded image data. Not really sure the maximum length HomeKit allows.

  // var respDict = {
  //   "type": "Interface",
  //   "interface": "instruction",
  //   "title": "Almost There",
  //   "detail": "Please press the button on the bridge to finish the setup.",
  //   "heroImage": "base64 image data",
  //   "showActivityIndicator": true,
  // "showNextButton": true,
  // "buttonText": "Login in browser",
  // "actionURL": "https://google.com"
  // }

  // Plugin can set context to allow it track setup process
  context.ts = "Hello";

  // Invoke callback to update setup UI
  callback(respDict);
};

// Sample function to show how developer can add accessory dynamically from outside event
MultiZonePlatform.prototype.addAccessory = function(accessoryName, zone) {
  this.log("Add Accessory");
  var platform = this;
  var uuid;

  uuid = UUIDGen.generate(accessoryName);

  var newAccessory = new Accessory(accessoryName, uuid);
  newAccessory.on('identify', function(paired, callback) {
    platform.log(newAccessory.displayName, "Identify!!!");
    callback();
  });
  // Plugin can save context on accessory to help restore accessory in configureAccessory()
  // newAccessory.context.something = "Something"
  
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  newAccessory.thermostatService = newAccessory.addService(Service.Thermostat, accessoryName);
  newAccessory.log=this.log;
  newAccessory.zone=zone;
  newAccessory.zoneSensorMap=zoneSensorMap;
  //extend this service
  MakeThermostat(newAccessory);

  this.accessories.push(newAccessory);
  this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [newAccessory]);
};

MultiZonePlatform.prototype.updateAccessoriesReachability = function() {
  this.log("Update Reachability");
  for (var index in this.accessories) {
    var accessory = this.accessories[index];
    accessory.updateReachability(false);
  }
};

// Sample function to show how developer can remove accessory dynamically from outside event
MultiZonePlatform.prototype.removeAccessory = function() {
  this.log("Remove Accessory");
  this.api.unregisterPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", this.accessories);

  this.accessories = [];
};

function MakeThermostat(accessory){
    accessory.sensorData={};
    accessory.getCurrentTemperature=function(){
      var sum=0;
      var count=1;
      for(var sensor in accessory.sensorData){
        sum+=Number(sensor['temp']);
        count++;
      }
      return sum/count;
    };
    
    // Off, Heat, Cool
    accessory.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', callback => {
        accessory.log('CurrentHeatingCoolingState:', accessory.currentHeatingCoolingState);
        callback(null, accessory.currentHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        accessory.log('SET CurrentHeatingCoolingState from', accessory.currentHeatingCoolingState, 'to', value);
        accessory.currentHeatingCoolingState = value;
        accessory.lastCurrentHeatingCoolingStateChangeTime = new Date();
        if (accessory.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF) {
          accessory.stopSystemTimer = null;
        } else {
          accessory.startSystemTimer = null;
        }
        callback(null);
      });

    // Off, Heat, Cool, Auto
    accessory.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', callback => {
        accessory.log('TargetHeatingCoolingState:', accessory.targetHeatingCoolingState);
        callback(null, accessory.targetHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        accessory.log('SET TargetHeatingCoolingState from', accessory.targetHeatingCoolingState, 'to', value);
        accessory.targetHeatingCoolingState = value;
        accessory.updateSystem();
        callback(null);
      });

    // Current Temperature
    accessory.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: accessory.minTemperature,
        maxValue: accessory.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        accessory.log('CurrentTemperature:', accessory.getCurrentTemperature());
        callback(null, accessory.getCurrentTemperature());
      })
      .on('set', (value, callback) => {
        accessory.updateSystem();
        callback(null);
      });

    // Target Temperature
    accessory.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: accessory.minTemperature,
        maxValue: accessory.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        accessory.log('TargetTemperature:', accessory.targetTemperature);
        callback(null, accessory.targetTemperature);
      })
      .on('set', (value, callback) => {
        accessory.log('SET TargetTemperature from', accessory.targetTemperature, 'to', value);
        accessory.targetTemperature = value;
        accessory.updateSystem();
        callback(null);
      });

    // °C or °F for units
    accessory.thermostatService
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', callback => {
        accessory.log('TemperatureDisplayUnits:', accessory.temperatureDisplayUnits);
        callback(null, accessory.temperatureDisplayUnits);
      })
      .on('set', (value, callback) => {
        accessory.log('SET TemperatureDisplayUnits from', accessory.temperatureDisplayUnits, 'to', value);
        accessory.temperatureDisplayUnits = value;
        callback(null);
      });

    // Get Humidity
    accessory.thermostatService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', callback => {
        accessory.log('CurrentRelativeHumidity:', accessory.currentRelativeHumidity);
        callback(null, accessory.currentRelativeHumidity);
      });
      
    // GetPressure
    accessory.thermostatService
      .getCharacteristic(CustomCharacteristic.AirPressure)
      .on('get', callback => {
        accessory.log('CurrentAirPressure:', accessory.currentPressure);
        callback(null, accessory.currentPressure);
      });

    // Auto max temperature
    accessory.thermostatService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: accessory.minTemperature,
        maxValue: accessory.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        accessory.log('CoolingThresholdTemperature:', accessory.coolingThresholdTemperature);
        callback(null, accessory.coolingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        accessory.log('SET CoolingThresholdTemperature from', accessory.coolingThresholdTemperature, 'to', value);
        accessory.coolingThresholdTemperature = value;
        callback(null);
      });

    // Auto min temperature
    accessory.thermostatService
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: accessory.minTemperature,
        maxValue: accessory.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        accessory.log('HeatingThresholdTemperature:', accessory.heatingThresholdTemperature);
        callback(null, accessory.heatingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        accessory.log('SET HeatingThresholdTemperature from', accessory.heatingThresholdTemperature, 'to', value);
        accessory.heatingThresholdTemperature = value;
        callback(null);
      });

    accessory.thermostatService
      .getCharacteristic(Characteristic.Name)
      .on('get', callback => {
        callback(null, accessory.name);
      });
}