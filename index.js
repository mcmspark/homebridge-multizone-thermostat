var http = require('http');
var gpio = require('rpi-gpio');
var BME280 = require('node-adafruit-bme280');
var SerialPort = require('serialport');

gpio.setMode(gpio.MODE_BCM);

var OFF = true;
var ON = false;

var platform, Accessory, Service, Characteristic, AirPressure, UUIDGen, sensorData, zoneSensorMap, zonePinMap;


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
zonePinMap=[0,17,27,22];

sensorData={};

var zonecount=0;

module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  
  for(var i=1;i<zonePinMap.length;i++)gpio.setup(zonePinMap[i], gpio.DIR_HIGH);
  
  AirPressure = function() {
        Characteristic.call(this, 'Air Pressure', 'E863F10F-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'hectopascals',
          minValue: 700,
          maxValue: 110000,
          minStep: 1,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
  };
  AirPressure.prototype=Object.create(Characteristic.prototype);
  AirPressure.UUID = 'E863F10F-079E-48FF-8F27-9C2605A29F52';
  
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform("homebridge-multizone-thermostat", "MultiZonePlatform", MultiZonePlatform, true);
};

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
function MultiZonePlatform(log, config, api) {
  log("MultiZonePlatform Init");
  platform = this;
  this.log = log;
  this.config = config;
  
  this.sensorCheckMilliseconds=60000;
  
  this.accessories = [];

  this.requestServer = http.createServer(function(request, response) {
    if (request.url === "/temp") {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/json');
      response.end(JSON.stringify(sensorData));
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
  //var zone=1;
  //this.addAccessory("Zone" + zone + " Thermostat", zone);
  this.startSensorLoops();
}

MultiZonePlatform.prototype.startSensorLoops=function(){
  this.sensorInterval=setInterval(this.readTemperatureFromI2C,this.sensorCheckMilliseconds);
  var port = new SerialPort('/dev/serial0', {
      baudRate: 9600
  });
  port.msgbuff="";
  port.on('error',function(err){
      console.write("cannot open port - " + err);
  });
  port.on('open', function() {
    console.log('port open');
  });
  port.on('data', function(data){
//    console.log(data.toString());
    this.msgbuff+=data.toString();
    while(this.msgbuff.length>11 && this.msgbuff.length-this.msgbuff.indexOf("a")>11){
      var pos=this.msgbuff.indexOf("a")
      var msg=this.msgbuff.substr(pos,12);
      this.msgbuff=this.msgbuff.substr(13);
      var deviceid=msg.substr(1,2);
//      console.log(deviceid + "  - " + msg + " " + msgbuff.length);
      var type=msg.substr(3,4);
      if(type=="TEMP"){platform.updateSensorData(deviceid,Number(msg.substr(7)),null,null,null);}
      if(type=="BATT"){platform.updateSensorData(deviceid,null,Number(msg.substr(7,4)),null,null);}
    }
  });
};
MultiZonePlatform.prototype.getZoneForSensor=function(sensorName){
  for(var z in zoneSensorMap){
    if(zoneSensorMap[z][sensorName]){
      //this.log("found");
      return z;
    }
  }  
  //this.log("NOT found");
  return undefined;
};

MultiZonePlatform.prototype.getAccessoryForSensor=function(sensorName){
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    //this.log("Searching " + accessory.displayName + " in zone " + accessory.zone + " for " + sensorName + " = " + JSON.stringify(zoneSensorMap[accessory.zone][sensorName]));
    if(accessory.zone && zoneSensorMap[accessory.zone] && zoneSensorMap[accessory.zone][sensorName]){
      //this.log("found");
      return accessory;
    }
  }  
  //this.log("NOT found");
  return undefined;
};

MultiZonePlatform.prototype.updateSensorData = function(sensorName, temperature, battery, pressure, humidity){
  //this is the global copy of all sensors for debugging
  var sdata=sensorData[sensorName];
  if(sdata==undefined){
      sensorData[sensorName]={};
      sdata=sensorData[sensorName];
    }
  sdata['temp'] = temperature || sdata['temp'];
  sdata['batt'] = battery || sdata['batt'];
  sdata['press'] = pressure || sdata['press'];
  sdata['humid'] = humidity || sdata['humid'];
  sdata['time'] = Date.now();
  //sensorData[sensorName]={'temp':temperature, 'batt': battery, 'press':pressure, 'humid':humidity};
  //this.log(sensorName + " : " + JSON.stringify(sdata));
  var accessory=this.getAccessoryForSensor(sensorName);
  if(accessory){
    sdata=accessory.sensorData[sensorName];
    if(sdata==undefined){
      if(accessory.sensorData==undefined)accessory.sensorData={};
      accessory.sensorData[sensorName]={};
    }
    sdata=accessory.sensorData[sensorName];
    //this.log("update sendor data", sensorName, JSON.stringify(sdata));
    sdata['temp'] = temperature || sdata['temp'];
    sdata['batt'] = battery || sdata['batt'];
    sdata['press'] = pressure || sdata['press'];
    sdata['humid'] = humidity || sdata['humid'];
    sdata['time'] = Date.now();
    accessory.readSensorData();
  }else{
    var zone=this.getZoneForSensor(sensorName);
    if(zone){
      this.log("Found: Sensor",sensorName,"Add Zone"+zone);
      this.addAccessory("Zone" + zone + " Thermostat", zone);
    }
  }
};

MultiZonePlatform.prototype.readTemperatureFromI2C = function() {
  try{
    BME280.probe((temperature, pressure, humidity) => {
        platform.updateSensorData('BM', temperature-1.1111, null, pressure, humidity);
    });
  }catch(err){this.log(err);}
};

// Function invoked when homebridge tries to restore cached accessory.
// Developer can configure accessory at here (like setup event handler).
// Update current value.
MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  this.log(accessory.displayName,"Configure Accessory");
  var platform = this;
  accessory.log=this.log;
  var zone=accessory.displayName.substr(accessory.displayName.indexOf("Zone")+4,1);
  accessory.zone=zone;
  accessory.zoneSensorMap=zoneSensorMap;
  /*
  this.log("This accessory has",accessory.services.length,"services");
  this.log("Service.AccessoryInformation",accessory.getService(Service.AccessoryInformation) instanceof Service);
  this.log("Service.BatteryService",accessory.getService(Service.BatteryService) instanceof Service);
  this.log("Service.Thermostat",accessory.getService(Service.Thermostat) instanceof Service);
  */
  //make this a Service.Thermostat and add handlers
  MakeThermostat(accessory);
  //if(this.api)this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [accessory]);
  
  // Set the accessory to reachable if plugin can currently process the accessory,
  // otherwise set to false and update the reachability later by invoking 
  // accessory.updateReachability()
  accessory.reachable = true;
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
  context.ts = "MultiZoneContext";

  // Invoke callback to update setup UI
  callback(respDict);
};
var pendingAccessories=[];
// Sample function to show how developer can add accessory dynamically from outside event
MultiZonePlatform.prototype.addAccessory = function(accessoryName, zone) {
  if(pendingAccessories.includes(accessoryName)){
    this.log("Pending",accessoryName);
    return;
  }
  pendingAccessories.push(accessoryName);
  this.log("Add Accessory",accessoryName);
  var accessory = new Accessory(accessoryName, UUIDGen.generate(accessoryName));
  accessory.zone=zone;
  accessory.zoneSensorMap=zoneSensorMap;
  accessory.log=this.log;
  //make this a Service.Thermostat and add handlers
  MakeThermostat(accessory);
  if(this.api)this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [accessory]);
  accessory.reachable = true;
  this.accessories.push(accessory);
  pendingAccessories=pendingAccessories.filter(x => x!=accessoryName);
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
    // Plugin can save context on accessory to help restore accessory in configureAccessory()
    // accessory.context.something = "Something"
    accessory.sensorData={};
    accessory.readSensorData=function(){
    //  accessory.log("readSensorData",
      accessory.batteryService.getCharacteristic(Characteristic.BatteryLevel).getValue(null);
      accessory.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).getValue(null);
    }
    
    accessory.averageSensorValue=function(sensorType){
      var sum=0;
      var count=0;
      for(var sensorName in accessory.sensorData){
        var val=accessory.sensorData[sensorName][sensorType];
        if(val){
          sum+=Number(val);
          count++;
        }
      }
      return count>0 ? sum/count : 0;
    };  
    var svc=accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
        .setCharacteristic(Characteristic.Model, 'Zone Thermostat')
        .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
        .setCharacteristic(Characteristic.FirmwareRevision, 'unknown');

    accessory.on('identify', function(paired, callback) {
      platform.log(accessory.displayName, "Identify!!!");
      callback();
    });
    

    accessory.currentlyRunning=function(){
      return accessory.systemStateName(accessory.currentHeatingCoolingState);
    }
  
    accessory.shouldTurnOnHeating=function(){
      return (accessory.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.HEAT && accessory.averageSensorValue('temp') < accessory.targetTemperature)
        || (accessory.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.AUTO && accessory.averageSensorValue('temp') < accessory.heatingThresholdTemperature);
    }
  
    accessory.shouldTurnOnCooling=function(){
      return (accessory.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.COOL && accessory.averageSensorValue('temp') > accessory.targetTemperature)
        || (accessory.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.AUTO && accessory.averageSensorValue('temp') > accessory.coolingThresholdTemperature);
    }
  
    accessory.systemStateName=function(heatingCoolingState) {
      if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
        return 'Heat';
      } else if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
        return 'Cool';
      } else {
        return 'Off';
      }
    }
  
    accessory.clearTurnOnInstruction=function(){
      accessory.log('CLEARING Turn On instruction');
      clearTimeout(accessory.startSystemTimer);
      accessory.startSystemTimer = null;
    }
  
    accessory.turnOnSystem=function(systemToTurnOn) {
      if (accessory.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF) {
        if (!accessory.startSystemTimer) {
          accessory.log(`STARTING ${accessory.systemStateName(systemToTurnOn)} in ${accessory.startDelay / 1000} second(s)`);
          accessory.startSystemTimer = setTimeout(() => {
            accessory.log(`START ${accessory.systemStateName(systemToTurnOn)}`);
            gpio.write(zonePinMap[accessory.zone], ON);
            accessory.thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
          }, accessory.startDelay);
        } else {
          accessory.log(`STARTING ${accessory.systemStateName(systemToTurnOn)} soon...`);
        }
      } else if (accessory.currentHeatingCoolingState !== systemToTurnOn) {
        accessory.turnOffSystem();
      }
    }

    accessory.lastCurrentHeatingCoolingStateChangeTime=0;
    accessory.timeSinceLastHeatingCoolingStateChange=function(){
      return new Date() - accessory.lastCurrentHeatingCoolingStateChangeTime;
    }
  
    accessory.turnOffSystem=function(){
      if (!accessory.stopSystemTimer) {
        accessory.log(`STOP ${accessory.currentlyRunning} | Blower will turn off in ${accessory.blowerTurnOffTime / 1000} second(s)`);
        gpio.write(zonePinMap[accessory.zone], OFF);
        accessory.stopSystemTimer = setTimeout(() => {
          accessory.thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
        }, accessory.blowerTurnOffTime);
      } else {
        accessory.log(`INFO ${accessory.currentlyRunning} is stopped. Blower will turn off soon...`);
      }
    }
    
    accessory.updateSystem=function(){
      accessory.log("updating...");  
      if (accessory.timeSinceLastHeatingCoolingStateChange() < accessory.minimumOnOffTime) {
        const waitTime = accessory.minimumOnOffTime - accessory.timeSinceLastHeatingCoolingStateChange();
        accessory.log(`INFO Need to wait ${waitTime / 1000} second(s) before state changes.`);
        return;
      }
  
      if (accessory.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF
          && accessory.targetHeatingCoolingState !== Characteristic.TargetHeatingCoolingState.OFF) {
        if (accessory.shouldTurnOnHeating()) {
          accessory.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (accessory.shouldTurnOnCooling()) {
          accessory.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
        } else if (accessory.startSystemTimer) {
          accessory.clearTurnOnInstruction();
        }
      } else if (accessory.currentHeatingCoolingState !== Characteristic.CurrentHeatingCoolingState.OFF
          && accessory.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.OFF) {
        accessory.turnOffSystem();
      } else if (accessory.currentHeatingCoolingState !== Characteristic.CurrentHeatingCoolingState.OFF
                && accessory.targetHeatingCoolingState !== Characteristic.TargetHeatingCoolingState.OFF) {
        if (accessory.shouldTurnOnHeating()) {
          accessory.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (accessory.shouldTurnOnCooling()) {
          accessory.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
        } else {
          accessory.turnOffSystem();
        }
      } else if (accessory.startSystemTimer) {
        accessory.clearTurnOnInstruction();
      }
    };
    
    accessory.batteryService=accessory.getService(Service.BatteryService);
    if(accessory.batteryService==undefined){
      //accessory.log("    add Battery Service");
      accessory.batteryService=accessory.addService(Service.BatteryService, accessory.displayName);
    }
    accessory.batteryService
     .getCharacteristic(Characteristic.BatteryLevel)
     .on('get', callback => {
       this.value=accessory.averageSensorValue('batt')*33;
       //accessory.log('BatteryLevel:', this.value);
       callback(null, this.value);
     });
    accessory.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', callback => {
        this.value=(accessory.averageSensorValue('batt')<2.5);
        callback(null, this.value);
      });
    
    accessory.thermostatService=accessory.getService(Service.Thermostat);
    if(accessory.thermostatService==undefined){
      //accessory.log("    add Thermostat Service");
      accessory.thermostatService=accessory.addService(Service.Thermostat, accessory.displayName);
      //accessory.log("no service found added -??",accessory.thermostatService.displayName);
    } 
    
    // This causes a warning
    //if(accessory.thermostatService.getCharacteristic(AirPressure)==undefined)
    //  accessory.thermostatService.addCharacteristic(AirPressure);
    
    accessory.minimumOnOffTime = accessory.minimumOnOffTime || 120000; // In milliseconds
    accessory.startDelay = accessory.startDelay || 10000; // In milliseconds
    accessory.temperatureCheckInterval = accessory.temperatureCheckInterval || 10000; // In milliseconds
    
    accessory.minTemperature = accessory.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).minValue || 0;
    accessory.maxTemperature = accessory.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).maxValue || 44;
    accessory.targetTemperature = accessory.thermostatService.getCharacteristic(Characteristic.TargetTemperature).value || 21;
    accessory.heatingThresholdTemperature = accessory.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).value  || 18;
    accessory.coolingThresholdTemperature = accessory.thermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).value  || 24;
    accessory.temperatureDisplayUnits = accessory.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value || Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    accessory.currentHeatingCoolingState = accessory.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value || Characteristic.CurrentHeatingCoolingState.OFF;
    accessory.targetHeatingCoolingState = accessory.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value || Characteristic.TargetHeatingCoolingState.OFF;
    
    

    //setInterval(() => this.readTemperatureFromSensor(), this.temperatureCheckInterval);

    /*accessory.thermostatService
      .setCharacteristic(Characteristic.TargetTemperature, 21)
      .setCharacteristic(Characteristic.HeatingThresholdTemperature, 18)
      .setCharacteristic(Characteristic.CoolingThresholdTemperature, 24)
      .setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.FAHRENHEIT)
      .setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF)
      .setCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
    */
    // Off, Heat, Cool
    accessory.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', callback => {
        //accessory.log('CurrentHeatingCoolingState:', accessory.currentHeatingCoolingState);
        callback(null, accessory.currentHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        this.value=value;
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
        //accessory.log('TargetHeatingCoolingState:', accessory.targetHeatingCoolingState);
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
        this.value=accessory.averageSensorValue('temp');
        //accessory.log('CurrentTemperature:', this.value);
        callback(null, this.value);
      })
      .on('set', (value, callback) => {
        this.value=value;
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
        //accessory.log('TargetTemperature:', accessory.targetTemperature);
        callback(null, accessory.targetTemperature);
      })
      .on('set', (value, callback) => {
        this.value=value;
        accessory.log('SET TargetTemperature from', accessory.targetTemperature, 'to', value);
        accessory.targetTemperature = value;
        accessory.updateSystem();
        callback(null);
      });

    // °C or °F for units
    accessory.thermostatService
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', callback => {
        //accessory.log('TemperatureDisplayUnits:', accessory.displayName, accessory.temperatureDisplayUnits);
        callback(null, accessory.temperatureDisplayUnits);
      })
      .on('set', (value, callback) => {
        this.value=value;
        accessory.log('SET TemperatureDisplayUnits from', accessory.temperatureDisplayUnits, 'to', value);
        accessory.temperatureDisplayUnits = value;
        callback(null);
      });

    // Get Humidity
    accessory.thermostatService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', callback => {
        this.value=accessory.averageSensorValue('humid');
        //accessory.log('CurrentRelativeHumidity:', accessory.getCurrentRelativeHumidity());
        callback(null, this.value);
      });
      
    // GetPressure
    accessory.thermostatService
      .getCharacteristic(AirPressure)
      .on('get', callback => {
        accessory.log('CurrentAirPressure:', accessory.averageSensorValue('press'));
        callback(null, accessory.getCurrentPressure());
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
        //accessory.log('CoolingThresholdTemperature:', accessory.coolingThresholdTemperature);
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
        //accessory.log('HeatingThresholdTemperature:', accessory.heatingThresholdTemperature);
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
        callback(null, accessory.displayName);
      });

}