'use strict';
var http = require('http');
var gpio = require('rpi-gpio');
var BME280 = require('node-adafruit-bme280');
var SerialPort = require('serialport');
var fs = require('fs');
var path = require('path');

gpio.setMode(gpio.MODE_BCM);

var OFF = true;
var ON = false;

var platform, Accessory, Service, Characteristic, AirPressure, UUIDGen, zones;


zones={
  "1" : {
      "relayPin" : 17,
      "sensors" : [
          {
              "id" : "AE",
              "location" : "snug",
              "source" : "serial",
              "extras" : "batt"
          },
          {
              "id" : "AF",
              "location" : "living",
              "source" : "serial",
              "extras" : "batt"
          },
          {
              "id" : "AH",
              "location" : "gavin",
              "source" : "serial",
              "extras" : "batt"
          },
          {
              "id" : "BM",
              "location" : "pi",
              "source" : "I2C",
              "extras" : "humid,press"
          }
      ]
  },
  "2" : {
      "relayPin" : 27,
      "sensors" : [
          {
              "id" : "AA",
              "location" : "master",
              "source" : "serial",
              "extras" : "batt"
          },
          {
              "id" : "AB",
              "location" : "tess",
              "source" : "serial",
              "extras" : "batt"
          },
          {
              "id" : "AC",
              "location" : "kate",
              "source" : "serial",
              "extras" : "batt"
          }
      ]
  },
  "3" : {
      "relayPin" : 22,
      "sensors" : [
          {
              "id" : "AD",
              "location" : "addition",
              "source" : "serial",
              "extras" : "batt"
          }
      ]
  }
};

module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  AirPressure = function() {
        Characteristic.call(this, 'Air Pressure', 'E863F10F-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'hectopascals',
          minValue: 1000,
          maxValue: 120000,
          minStep: 0.01,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        //this.value = this.getDefaultValue();
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
  
  this.zones = config.zones || zones;
  this.sensorCheckMilliseconds = config.sensorCheckMilliseconds || 60000;
  this.minOnOffTime = config.minOnOffTime || 300000;
  this.startDelay = config.startDelay || 10000;
  this.serverPort = config.serverPort || 3000;
  this.serialPort = config.serialPort || '/dev/serial0';
  this.serialCfg = config.serialCfg || { baudRate : 9600 };
  
  for(var zone in zones){
    try{
      platform.log("setup pin", zones[zone]["relayPin"]);
      gpio.setup(zones[zone]["relayPin"], gpio.DIR_HIGH);
    }catch(err){
      platform.log("error",JSON.stringify(err));
    }
  }
 
  this.accessories = [];

  this.requestServer = http.createServer(function(request, response) {
    //platform.log("serving",request.url);
    if (request.url.toLowerCase().indexOf("/status")==0) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/json');
      response.end(platform.getStatus());
    }
    else if(request.url === "/" || request.url === ""){
      this.returnFileContents("/index.html", response);
    }
    else if(request.url.indexOf("/set/")==0){
      var parts=request.url.split("/");
      if(parts.length>3){
        var z = parts[2];
        var setVal=parts[3];
        this.setTemperature(z,setVal);
      }
    }
    else this.returnFileContents(request.url, response);
  }.bind(this));

  this.requestServer.listen(platform.serverPort, function() {
    platform.log("Server Listening on port", platform.serverPort);
  });

  if (api) {
      this.api = api;
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
        platform.startSensorLoops();      
      }.bind(this));
  }else{
    platform.startSensorLoops();
  }
}


MultiZonePlatform.prototype.returnFileContents=function(url, response){
   var filePath=path.resolve(__dirname,url.substr(1));
   fs.readFile(filePath, function (err, data) {
        if (err) {
          console.log("error", "cannot read", filePath, err);
          response.statusCode = 404;
          response.end();
        }else{
          response.setHeader('Content-Type', 'text/html');
          response.statusCode = 200;
          response.end(data);
        }
      });
};

MultiZonePlatform.prototype.getStatus=function(){
  var retval=[];
  //return retval;
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.thermostatService;
    if(service){
      var currentTemp = service.getValue(Characteristic.CurrentTemperature);
      var targetTemp = service.getValue(Characteristic.TargetTemperature);
      if(service.getValue(Characteristic.TemperatureDisplayUnits)==Characteristic.TemperatureDisplayUnits.FAHRENHEIT){
        currentTemp=currentTemp*9/5+32;
        targetTemp=targetTemp*9/5+32;
      }
      var item={
        'name': accessory.displayName,
        'currentTemp': Math.round(currentTemp),
        'setPoint': Math.round(targetTemp),
        'running': service.getValue(Characteristic.CurrentHeatingCoolingState)>0
      };
      retval.push(item);
    }
  }
  return JSON.stringify(retval);
  //return '[{"name":"zone1","currentTemp":68,"setPoint":70,"running":true},{"name":"zone2","currentTemp":69,"setPoint":71,"running":true},{"name":"zone3","currentTemp":71,"setPoint":70,"running":false}]';
};

MultiZonePlatform.prototype.setTemperature=function(zone,temp){
  zone=decodeURIComponent(zone);
  platform.log("setTemperature",zone,temp);
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.thermostatService;
    if(accessory.displayName==zone && service){
      platform.log("set zone", zone, "to", temp);
      if(service.getValue(Characteristic.TemperatureDisplayUnits)==Characteristic.TemperatureDisplayUnits.FAHRENHEIT){
        temp=(temp-32)*5/9;
      }
      if(temp<=service.maxTemperature && temp>=service.minTemperature){
        service.setCharacteristic(Characteristic.TargetTemperature,temp);
      }    
    }
  }
};

MultiZonePlatform.prototype.startSensorLoops=function(){
  this.sensorInterval=setInterval(this.readTemperatureFromI2C,this.sensorCheckMilliseconds);
  var port = new SerialPort(this.serialPort, this.serialCfg);
  platform.msgbuff="";
  port.on('error',function(err){
      platform.log('error',"cannot open serial port - " + err);
  });
  port.on('open', function() {
      platform.log('serial port open');
  });
  port.on('data', function(data){
    platform.msgbuff+=data.toString();
    while(platform.msgbuff.length>11 && platform.msgbuff.length-platform.msgbuff.indexOf("a")>11){
      var pos=platform.msgbuff.indexOf("a")
      var msg=platform.msgbuff.substr(pos,12);
      platform.msgbuff=platform.msgbuff.substr(13);
      var deviceid=msg.substr(1,2);
      var type=msg.substr(3,4);
      if(type=="TEMP"){platform.updateSensorData(deviceid,{ "temp" : Number(msg.substr(7)) });}
      if(type=="BATT"){platform.updateSensorData(deviceid,{ "batt" : Number(msg.substr(7,4)) });}
    }
  });
};

MultiZonePlatform.prototype.readTemperatureFromI2C = function() {
  try{
    BME280.probe((temperature, pressure, humidity) => {
        platform.updateSensorData('BM', { 'temp' : temperature-1.1111, 'press' : pressure, 'humid' : humidity });
    });
  }catch(err){platform.log('error',err);}
};

MultiZonePlatform.prototype.updateSensorData = function(deviceid, data){
  //platform.log("updateSensorData",deviceid);
  var foundAccessories = false;
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    for(var j in accessory.services){
      var service = accessory.services[j];
      if(service.deviceList && service.deviceList.includes(deviceid))
      {
        //platform.log(JSON.stringify(service.deviceList));
        foundAccessories=true;
        this.setCharacteristics(service,deviceid,data);
      }
    }
  }
  if(!foundAccessories){
     this.addAccessoriesForSensor(deviceid, data);
  }
};

MultiZonePlatform.prototype.testCharacteristic=function(service,name){
  // checks for the existence of a characteristic object in the service
  var index, characteristic;
  for (index in service.characteristics) {
    characteristic = service.characteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  for (index in service.optionalCharacteristics) {
    characteristic = service.optionalCharacteristics[index];
    if (typeof name === 'string' && characteristic.displayName === name) {
      return true;
    }
    else if (typeof name === 'function' && ((characteristic instanceof name) || (name.UUID === characteristic.UUID))) {
      return true;
    }
  }
  return false;
}

MultiZonePlatform.prototype.setCharacteristics = function(service,deviceid,data){
  //platform.log("setCharacteristics",deviceid);
  for(var dataType in data){
    //platform.log("dataType", dataType,"=",data[dataType]);
    service.sensorData=service.sensorData || {};
    service.sensorData[deviceid]=service.sensorData[deviceid] || {};
    service.sensorData[deviceid][dataType]=data[dataType];
    switch(dataType){
      case 'temp':  //TODO : This is last one in wins, need a better way
        if(this.testCharacteristic(service,Characteristic.CurrentTemperature))
        {
          //platform.log('set temp');
          service.setCharacteristic(Characteristic.CurrentTemperature,Number(data[dataType]));
        }
        break;
      case 'batt':  //TODO : This is last one in wins, need a better way
        if(this.testCharacteristic(service,Characteristic.BatteryLevel))
        {
          //platform.log('set batt');
          service.setCharacteristic(Characteristic.BatteryLevel,Number(data[dataType])*33);
          service.setCharacteristic(Characteristic.StatusLowBattery,Number(data[dataType])<2.5);
        }
        break;
      case 'humid':
        if(this.testCharacteristic(service,Characteristic.CurrentRelativeHumidity))
        {
          //platform.log('set humid');
          service.setCharacteristic(Characteristic.CurrentRelativeHumidity,Number(data[dataType]));
        }
        break;
      case 'press':
        if(this.testCharacteristic(service,AirPressure))
        {
          //platform.log('set press');
          service.setCharacteristic(AirPressure,Number(data[dataType]));
        }
        break;
      default:
          platform.log('error','no support for',dataType,'from sensor',deviceid);
    }
  }
};

MultiZonePlatform.prototype.addAccessoriesForSensor = function(deviceid,data){
  // no service was assigned this device
  // add all accessories and services needed and set characteristics
 
  //Get the Zone data for the device
  for(var zone in zones){
    for(var i in zones[zone]["sensors"]){
      var sensor=zones[zone]["sensors"][i];
      if(sensor['source']=='serial'){
        //create a temperature sensor
        this.addAccessory(sensor['id']);
      }
      //create a thermostat
      this.addAccessory("Zone"+zone+" Thermostat");
    }
  }
  this.updateSensorData(deviceid,data);
};

MultiZonePlatform.prototype.addAccessory = function(accessoryName) {
  // check we dont already have that one
  for(var i in this.accessories){
    if (this.accessories[i].displayName==accessoryName) {
      return;
    }
  }
  
  platform.log("Add Accessory",accessoryName);
  var uuid = UUIDGen.generate(accessoryName);

  var accessory = new Accessory(accessoryName, uuid);
  accessory.on('identify', function(paired, callback) {
    platform.log(accessory.displayName, "Identify!!!");
    callback();
  });
  
  this.configureAccessory(accessory);
  this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [accessory]);
};

MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  platform.log(accessory.displayName,"Configure Accessory");
  // add a Battery service
  //platform.log("add battery service to ", accessory.displayName);
  accessory.batteryService=accessory.getService(Service.BatteryService);
  if(accessory.batteryService==undefined){
    accessory.batteryService=accessory.addService(Service.BatteryService, accessory.displayName);
  }
  accessory.batteryService.typename="BatteryService";
      
  if(accessory.displayName.indexOf('Zone')>=0){
    this.makeThermostat(accessory);
  }else{
    this.makeTemperatureSensor(accessory);
  }
  
  accessory.reachable = true;
  this.accessories.push(accessory);
};

// Handler will be invoked when user try to config your plugin.
// Callback can be cached and invoke when necessary.
MultiZonePlatform.prototype.configurationRequestHandler = function(context, request, callback) {
  platform.log("Context: ", JSON.stringify(context));
  platform.log("Request: ", JSON.stringify(request));

  // Check the request response
  if (request && request.response && request.response.inputs && request.response.inputs.name) {
    this.addAccessory(request.response.inputs.name);

    // Invoke callback with config will let homebridge save the new config into config.json
    // Callback = function(response, type, replace, config)
    // set "type" to platform if the plugin is trying to modify platforms section
    // set "replace" to true will let homebridge replace existing config in config.json
    // "config" is the data platform trying to save
    callback(null, "platform", true, 
        {
          "platform" : "MultiZonePlatform",
          "name" : "MultiZone Platform", 
          "zones" : this.zones,
          "sensorCheckMilliseconds" : this.sensorCheckMilliseconds,
          "startDelay" : this.startDelay,
          "minOnOffTime" : this.minOnOffTime,
          "serverPort" : this.serverPort,
          "serialPort" : this.serialPort,
          "serialCfg" : this.serialCfg
        });
    return;
  }

  var respDict = {
    "type": "Interface",
    "interface": "input",
    "title": "Add Accessory",
    "items": [
      {
        "id": "name",
        "title": "Name",
        "placeholder": "Zone Thermostat"
      }
    ]
  };

  context.ts = "MultiZoneContext";
  callback(respDict);
};

MultiZonePlatform.prototype.makeTemperatureSensor=function(accessory){
  accessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
    .setCharacteristic(Characteristic.Model, 'Serial Temperature Sensor')
    .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
    .setCharacteristic(Characteristic.FirmwareRevision, 'unknown');
  // add a Temerature service
  accessory.tempService=accessory.getService(Service.TemperatureSensor);
  if(accessory.tempService==undefined){
    accessory.tempService=accessory.addService(Service.TemperatureSensor, accessory.displayName);
    accessory.tempService.typename="TemperatureSensor";
  }
  accessory.tempService.deviceList=[accessory.displayName];
  accessory.batteryService.deviceList=[accessory.displayName];
};
// ********************************************************************
//
//   Set up the Service as a functioning Thermostat
//
MultiZonePlatform.prototype.makeThermostat=function(accessory){
  //platform.log("makeThermostat",accessory.displayName);
  this.setUpThermostatServices(accessory);
  this.setThermostatCharacteristics(accessory.thermostatService);  
  this.setThermostatDefaults(accessory.thermostatService);
  this.setThermostatBehaviors(accessory.thermostatService);
};
// ********************************************************************

MultiZonePlatform.prototype.setUpThermostatServices=function(accessory){
  var zone=accessory.displayName.substr(accessory.displayName.indexOf("Zone")+4,1);
  accessory.zone=zone;
  
  accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
      .setCharacteristic(Characteristic.Model, 'Zone Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
      .setCharacteristic(Characteristic.FirmwareRevision, '1');
    // add a Thermostat service
  accessory.thermostatService=accessory.getService(Service.Thermostat);
    if(accessory.thermostatService==undefined){
      accessory.thermostatService=accessory.addService(Service.Thermostat, accessory.displayName);
    }
  accessory.thermostatService.typename="Thermostat";
  accessory.thermostatService.relayPin=zones[zone]['relayPin'];
  accessory.thermostatService.sensorData={};
  accessory.thermostatService.averageSensorValue=function(sensorType){
    var sum=0;
    var count=0;
    for(var sensorName in accessory.thermostatService.sensorData){
      var val=accessory.thermostatService.sensorData[sensorName][sensorType];
      if(val){
        sum+=Number(val);
        count++;
      }
    }
    return count>0 ? sum/count : 0;
  };
  accessory.batteryService.deviceList=[];
  accessory.thermostatService.deviceList=[];
  for(var i in zones[zone]["sensors"]){
    var sensor=zones[zone]["sensors"][i];
    accessory.thermostatService.deviceList.push(sensor['id']);
    if(sensor['extras'].indexOf('press')>=0){
      // add AirPressure Characteristic
      // This causes a warning
      //platform.log("adding air pressure to ", zone, sensor['id']);
      if(accessory.thermostatService.getCharacteristic(AirPressure)==undefined)
        accessory.thermostatService.addCharacteristic(AirPressure);
    }
    if(sensor['extras'].indexOf('batt')>=0){
      accessory.batteryService.deviceList.push(sensor['id']);
    }
  }
  accessory.batteryService.minSensorValue=function(sensorType){
    var min=3;
    for(var sensorName in accessory.batteryService.sensorData){
      var val=accessory.batteryService.sensorData[sensorName][sensorType];
      if(val && val<min){
        min=val;
      }
    }
    return min;
  };
  accessory.batteryService
     .getCharacteristic(Characteristic.BatteryLevel)
     .on('get', callback => {
       this.value=accessory.batteryService.minSensorValue('batt')*33;
       callback(null, this.value);
     })
     .on('set', (value, callback) => {
       this.value=accessory.batteryService.minSensorValue('batt')*33;
       callback(null);
     });
  accessory.batteryService
    .getCharacteristic(Characteristic.StatusLowBattery)
    .on('get', callback => {
      this.value=(accessory.batteryService.minSensorValue('batt')<2.5);
      callback(null, this.value);
    });
};

MultiZonePlatform.prototype.setThermostatCharacteristics=function(service){
  //platform.log("setThermostatCharacteristics",service.displayName,service.typename);
  
  service.getValue=function(characteristic){
    return service.getCharacteristic(characteristic).value;
  };
  // Off, Heat, Cool
    service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', callback => {
        //accessory.log('CurrentHeatingCoolingState:', accessory.currentHeatingCoolingState);
        callback(null, service.currentHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        this.value=value;
        //platform.log('SET CurrentHeatingCoolingState from', service.currentHeatingCoolingState, 'to', value, service.displayName);
        service.currentHeatingCoolingState = value;
        service.lastCurrentHeatingCoolingStateChangeTime = new Date();
        if (service.currentHeatingCoolingState === Characteristic.CurrentHeatingCoolingState.OFF) {
          service.stopSystemTimer = null;
        } else {
          service.startSystemTimer = null;
        }
        callback(null);
      });

    // Off, Heat, Cool, Auto
    service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', callback => {
        //accessory.log('TargetHeatingCoolingState:', accessory.targetHeatingCoolingState);
        callback(null, service.targetHeatingCoolingState);
      })
      .on('set', (value, callback) => {
        platform.log('SET TargetHeatingCoolingState from', service.targetHeatingCoolingState, 'to', value, service.displayName);
        service.targetHeatingCoolingState = value;
        service.updateSystem();
        callback(null);
      });

    // Current Temperature
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: service.minTemperature,
        maxValue: service.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        this.value=service.averageSensorValue('temp');
        //accessory.log('CurrentTemperature:', this.value);
        callback(null, this.value);
      })
      .on('set', (value, callback) => {
        this.value=service.averageSensorValue('temp');
        service.updateSystem();
        callback(null);
      });

    // Target Temperature
    service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: service.minTemperature,
        maxValue: service.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        //accessory.log('TargetTemperature:', accessory.targetTemperature);
        callback(null, service.targetTemperature);
      })
      .on('set', (value, callback) => {
        this.value=value;
        platform.log('SET TargetTemperature from', service.targetTemperature, 'to', value, service.displayName);
        service.targetTemperature = value;
        service.updateSystem();
        callback(null);
      });

    // °C or °F for units
    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', callback => {
        //accessory.log('TemperatureDisplayUnits:', accessory.displayName, accessory.temperatureDisplayUnits);
        callback(null, service.temperatureDisplayUnits);
      })
      .on('set', (value, callback) => {
        this.value=value;
        platform.log('SET TemperatureDisplayUnits from', service.temperatureDisplayUnits, 'to', value, service.displayName);
        service.temperatureDisplayUnits = value;
        callback(null);
      });

  if(this.testCharacteristic(service,Characteristic.CurrentRelativeHumidity)){
    // Get Humidity
    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', callback => {
        this.value=service.averageSensorValue('humid');
        //accessory.log('CurrentRelativeHumidity:', accessory.getCurrentRelativeHumidity());
        callback(null, this.value);
      });
  }
  if(this.testCharacteristic(service,AirPressure)){
    // GetPressure
    service
      .getCharacteristic(AirPressure)
      .setProps({
          format: Characteristic.Formats.FLOAT,
          unit: 'hectopascals',
          minValue: 1000,
          maxValue: 120000,
          minStep: 0.01,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        })
      .on('get', callback => {
        this.value=service.averageSensorValue('press').toFixed(2);  // convert from hPA to inHg with /3386.39
        platform.log('CurrentAirPressure:', this.value);
        callback(null, this.value);
      });
  }

    // Auto max temperature
    service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: service.minTemperature,
        maxValue: service.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        //accessory.log('CoolingThresholdTemperature:', accessory.coolingThresholdTemperature);
        callback(null, service.coolingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        platform.log('SET CoolingThresholdTemperature from', service.coolingThresholdTemperature, 'to', value, service.displayName);
        service.coolingThresholdTemperature = value;
        callback(null);
      });

    // Auto min temperature
    service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: service.minTemperature,
        maxValue: service.maxTemperature,
        minStep: 0.1
      })
      .on('get', callback => {
        //accessory.log('HeatingThresholdTemperature:', accessory.heatingThresholdTemperature);
        callback(null, service.heatingThresholdTemperature);
      })
      .on('set', (value, callback) => {
        platform.log('SET HeatingThresholdTemperature from', service.heatingThresholdTemperature, 'to', value, service.displayName);
        service.heatingThresholdTemperature = value;
        callback(null);
      });

    service
      .getCharacteristic(Characteristic.Name)
      .on('get', callback => {
        callback(null, service.displayName);
      });
};

MultiZonePlatform.prototype.setThermostatDefaults=function(service){
  service.targetTemperature = service.getValue(Characteristic.TargetTemperature)>10?service.getValue(Characteristic.TargetTemperature): 21;
  service.temperatureDisplayUnits = service.getValue(Characteristic.TemperatureDisplayUnits) || Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  service.currentHeatingCoolingState = Characteristic.CurrentHeatingCoolingState.OFF;
  service.targetHeatingCoolingState = service.getValue(Characteristic.TargetHeatingCoolingState) || Characteristic.TargetHeatingCoolingState.OFF;
  
  service.minTemperature = service.getCharacteristic(Characteristic.HeatingThresholdTemperature).minValue || 0;
  service.maxTemperature = service.getCharacteristic(Characteristic.HeatingThresholdTemperature).maxValue || 44;
  service.heatingThresholdTemperature = service.getValue(Characteristic.HeatingThresholdTemperature)  || 18;
  service.coolingThresholdTemperature = service.getValue(Characteristic.CoolingThresholdTemperature)  || 24;
  service.minOnOffTime=this.minOnOffTime;
};

MultiZonePlatform.prototype.setThermostatBehaviors=function(service){
  //platform.log("setThermostatBehaviors",service.displayName,service.typename);
  //service.blowerTurnOffTime=10000;
  service.lastCurrentHeatingCoolingStateChangeTime=new Date();
  //  service.startDelay = service.startDelay || 10000; // In milliseconds
  service.updateGPIO=function(val){
    try{
      platform.log("update pin",service.relayPin);
      gpio.write(service.relayPin,val);
    }catch(err){
      platform.log("ERROR",JSON.stringify(err));
    }
  };
  
  service.systemStateName=function(heatingCoolingState) {
    if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
      return 'Heat';
    } else if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
      return 'Cool';
    } else {
      return 'Off';
    }
  };
  
  service.currentlyRunning=function(){
    return service.systemStateName(service.getValue(Characteristic.CurrentHeatingCoolingState));
  };
  
  service.clearTurnOnInstruction=function(){
    platform.log('CLEARING Turn On instruction', service.displayName);
    clearTimeout(service.startSystemTimer);
    service.startSystemTimer = null;
  };
  
  service.shouldTurnOnHeating=function(){
    return (service.getValue(Characteristic.TargetHeatingCoolingState) === Characteristic.TargetHeatingCoolingState.HEAT && 
            service.getValue(Characteristic.CurrentTemperature) < service.getValue(Characteristic.TargetTemperature))
      || (service.getValue(Characteristic.TargetHeatingCoolingState) === Characteristic.TargetHeatingCoolingState.AUTO &&
          service.getValue(Characteristic.CurrentTemperature) < service.getValue(Characteristic.HeatingThresholdTemperature));
  };
  
  service.shouldTurnOnCooling=function(){
    return (service.getValue(Characteristic.TargetHeatingCoolingState) === Characteristic.TargetHeatingCoolingState.COOL && 
            service.getValue(Characteristic.CurrentTemperature) > service.getValue(Characteristic.TargetTemperature))
      || (service.getValue(Characteristic.TargetHeatingCoolingState) === Characteristic.TargetHeatingCoolingState.AUTO &&
          service.getValue(Characteristic.CurrentTemperature) > service.getValue(Characteristic.CoolingThresholdTemperature));
  };
  
  service.turnOnSystem=function(systemToTurnOn) {
    if(service.getValue(Characteristic.CurrentHeatingCoolingState) === Characteristic.CurrentHeatingCoolingState.OFF){
      platform.log("START",service.systemStateName(systemToTurnOn), service.displayName);
      service.updateGPIO(ON);
      service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
      service.lastCurrentHeatingCoolingStateChangeTime=new Date();
      /*
      if (!service.startSystemTimer) {
        platform.log("STARTING",service.systemStateName(systemToTurnOn),"in",this.startDelay / 1000,"second(s)", service.displayName);
        service.startSystemTimer = setTimeout(() => {
          platform.log("START",service.systemStateName(systemToTurnOn), service.displayName);
          gpio.write(service.relayPin, ON);
          service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
        }, this.startDelay);
      } else {
        platform.log("STARTING",service.systemStateName(systemToTurnOn),"soon...", service.displayName);
      }
      */
    } else if (service.getValue(Characteristic.CurrentHeatingCoolingState) !== systemToTurnOn) {
      // if we want heat but it is cooling or vis versa
      service.turnOffSystem();
    }
  };

  service.timeSinceLastHeatingCoolingStateChange=function(){
    return (new Date() - service.lastCurrentHeatingCoolingStateChangeTime);
  };
  
  service.turnOffSystem=function(){
    platform.log("STOP",service.currentlyRunning(),service.displayName);
    service.updateGPIO(OFF);
    service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
    service.lastCurrentHeatingCoolingStateChangeTime=new Date();
    //if (!service.stopSystemTimer) {
      //platform.log("STOP",service.currentlyRunning(),"System will turn off in",service.blowerTurnOffTime / 1000,"second(s)", service.displayName);
      //gpio.write(service.relayPin, OFF);
      //service.stopSystemTimer = setTimeout(() => {
      //  service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      //}, service.blowerTurnOffTime);
    //} else {
      //platform.log("INFO",service.currentlyRunning(),"is stopped. Blower will turn off soon...");
    //}
  };
    
  service.updateSystem=function(){
    //platform.log("updating...",service.displayName, service.timeSinceLastHeatingCoolingStateChange() , service.minOnOffTime);  
    if (service.timeSinceLastHeatingCoolingStateChange() < service.minOnOffTime) {
      var waitTime = service.minOnOffTime - service.timeSinceLastHeatingCoolingStateChange();
      //platform.log("INFO Need to wait",waitTime / 1000,"second(s) before state changes.",service.displayName);
      return;
    }
    var currentState=service.getValue(Characteristic.CurrentHeatingCoolingState);
    var targetState=service.getValue(Characteristic.TargetHeatingCoolingState);
    //platform.log("Eval",currentState,targetState,service.shouldTurnOnHeating());

    if (currentState === Characteristic.CurrentHeatingCoolingState.OFF
        && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
      if (service.shouldTurnOnHeating()) {
        service.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
      } else if (service.shouldTurnOnCooling()) {
        service.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
      } else if (service.startSystemTimer) {
        service.clearTurnOnInstruction();
      }
    } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
        && targetState === Characteristic.TargetHeatingCoolingState.OFF) {
      service.turnOffSystem();
    } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
        && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
      if (service.shouldTurnOnHeating()) {
        service.turnOnSystem(Characteristic.CurrentHeatingCoolingState.HEAT);
      } else if (service.shouldTurnOnCooling()) {
        service.turnOnSystem(Characteristic.CurrentHeatingCoolingState.COOL);
      } else {
        service.turnOffSystem();
      }
    } else if (service.startSystemTimer) {
      service.clearTurnOnInstruction();
    }
    
    service.updateGPIO(service.getValue(Characteristic.CurrentHeatingCoolingState) === Characteristic.CurrentHeatingCoolingState.HEAT ? ON : OFF);
  };
};