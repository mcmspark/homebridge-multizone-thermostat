'use strict';
var http = require('http');
var gpio = require('rpi-gpio');
var BME280 = require('node-adafruit-bme280');
var SerialPort = require('serialport');
var fs = require('fs');
var path = require('path');
var mime=require('mime');

gpio.setMode(gpio.MODE_BCM);

var OFF = false;
var ON = true;

var platform, Accessory, Service, Characteristic, AirPressure, UUIDGen, zones, furnaceLog;


zones={
  "1" : {
      "relayPin" : 17,
      "sensors" : {
          "AE":{
              "location" : "snug",
              "source" : "serial",
              "extras" : "batt"
          },
          "AF":{
              "location" : "living",
              "source" : "serial",
              "extras" : "batt"
          },
          "AH":{
              "location" : "gavin",
              "source" : "serial",
              "extras" : "batt"
          },
          "BM":{
              "location" : "pi",
              "source" : "I2C",
              "extras" : "humid,press"
          }
        }
  },
  "2" : {
      "relayPin" : 27,
      "sensors" : {
          "AA":{
              "location" : "master",
              "source" : "serial",
              "extras" : "batt"
          },
          "AB":{
              "location" : "tess",
              "source" : "serial",
              "extras" : "batt"
          },
          "AC":{
              "location" : "kate",
              "source" : "serial",
              "extras" : "batt"
          }
        }
  },
  "3" : {
      "relayPin" : 22,
      "sensors" : {
          "AD":{
              "location" : "addition",
              "source" : "serial",
              "extras" : "batt"
          }
        }
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
function MultiZonePlatform(log, config, api) {
  log("MultiZonePlatform Init");
  platform = this;
  this.log = log;
  this.config = config;
  this.accessories = [];
  furnaceLog=[];
  this.zones = config.zones || zones;
  this.sensorCheckMilliseconds = config.sensorCheckMilliseconds || 60000;
  this.temperatureDisplayUnits = config.temperatureDisplayUnits || 1;
  this.minOnOffTime = config.minOnOffTime || 300000;
  this.startDelay = config.startDelay || 10000;
  this.serverPort = config.serverPort || 3000;
  this.serialPort = config.serialPort || '/dev/serial0';
  this.serialCfg = config.serialCfg || { baudRate : 9600 };
  this.hasBME280=true;
  this.setupGPIO();
  this.startup();
  if (api) {
      this.api = api;
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
        platform.startUI();
        platform.startSensorLoops();
        platform.startControlLoop();      
      }.bind(this));
      this.api.on('shutdown', function() {
        platform.shutdown();     
      }.bind(this));
  }else{
    platform.startUI();
    platform.startSensorLoops();
    platform.startControlLoop();
  }
}
MultiZonePlatform.prototype.startup=function(){
  try{
    platform.log("startup");
    var filePath="status.json";
    var status=JSON.parse(fs.readFileSync(filePath));
    platform.log(filePath, status.furnaceLog.length);
    furnaceLog=status.furnaceLog;
    platform.zones=status.zones;
  }catch(err){
    platform.log("cannot load status.json",err);
  }
};
MultiZonePlatform.prototype.shutdown=function(){
  var status=this.getStatus();
  platform.log("shutdown");
  var filePath="status.json";
  fs.writeFileSync(filePath,status);
};
MultiZonePlatform.prototype.startUI=function() {
  this.requestServer = http.createServer(function (request, response) {
    //platform.log("serving",request.url);
    if (request.url.toLowerCase().indexOf("/status") == 0) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/json');
      response.end(platform.getStatus());
    }
    else if (request.url === "/" || request.url === "") {
      this.returnFileContents("/index.html", response);
    }
    else if (request.url.indexOf("/set/") == 0) {
      var parts = request.url.split("/");
      if (parts.length > 3) {
        var z = parts[2];
        var setVal = parts[3];
        this.setTemperature(z, setVal);
      }
    }
    else
      this.returnFileContents(request.url, response);
  }.bind(this));
  this.requestServer.listen(platform.serverPort, function () {
    platform.log("Server Listening on port", platform.serverPort);
  });
};
MultiZonePlatform.prototype.setupGPIO=function() {
  for (var zone in this.zones) {
    try {
      platform.log("setup pin", this.zones[zone]["relayPin"]);
      gpio.setup(this.zones[zone]["relayPin"], gpio.DIR_LOW); // set to low and output
      for(var deviceid in this.zones[zone]["sensors"]){
        if(this.zones[zone]["sensors"][deviceid].source == "I2C")
          this.hasBME280 = true;
      }
    }
    catch (err) {
      platform.log('error', JSON.stringify(err));
    }
  }
};
MultiZonePlatform.prototype.returnFileContents=function(url, response){
   var filePath=path.resolve(__dirname,url.substr(1));
   var mimeType=mime.getType(filePath);
   //platform.log(mimeType);
   fs.readFile(filePath, function (err, data) {
        if (err) {
          console.log("error", "cannot read", filePath, err);
          response.statusCode = 404;
          response.end();
        }else{
          response.setHeader('Content-Type', mimeType || "text/plain");
          response.statusCode = 200;
          response.end(data);
        }
      });
};
MultiZonePlatform.prototype.getStatus=function(){
  var retval={};
  //return retval;
  for (var zone in this.zones) {
    var thermostat=this.getThermostatForZone(zone);
    //platform.log("what is",thermostat.displayName, thermostat instanceof Service.Thermostat);
    this.zones[zone]['currentTemp'] = thermostat.getCharacteristic(Characteristic.CurrentTemperature).value;
    this.zones[zone]['setPoint'] = thermostat.getCharacteristic(Characteristic.TargetTemperature).value;
    this.zones[zone]['running'] = thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value>0;
    this.zones[zone]['temperatureDisplayUnits'] = thermostat.getCharacteristic(Characteristic.TemperatureDisplayUnits).value==Characteristic.TemperatureDisplayUnits.FAHRENHEIT?"F":"C";
    //platform.log(this.zones[zone]['temperatureDisplayUnits']);
  }
  retval.zones=this.zones;
  retval.timestamp=new Date().toISOString();
  var oldestDate=new Date(Date.now() - 24 * 3600 * 1000);
  retval.furnaceLog=furnaceLog.filter(entry => Date.parse(entry.timestamp)>oldestDate);
  return JSON.stringify(retval);
};

MultiZonePlatform.prototype.setTemperature=function(zone,temp){
  zone=decodeURIComponent(zone);
  var thermostat=this.getThermostatForZone(zone);
  platform.log("set zone", zone, "to", temp);
  //if(thermostat.temperatureDisplayUnits==Characteristic.TemperatureDisplayUnits.FAHRENHEIT){
  //  temp=(temp-32)*5/9;
  //}
  //if(temp<=service.maxTemperature && temp>=service.minTemperature){
  thermostat.setCharacteristic(Characteristic.TargetTemperature,temp);
  platform.updateSystem();
  //}
};
MultiZonePlatform.prototype.startSensorLoops=function(){
  if (platform.hasBME280) {
    this.sensorInterval=setInterval(this.readTemperatureFromI2C,this.sensorCheckMilliseconds); 
  }
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
    platform.readCPUTemperature();
    BME280.probe((temperature, pressure, humidity) => {
        platform.updateSensorData('BM', { 'temp' : temperature-1.1111, 'press' : pressure, 'humid' : humidity });
    });
  }catch(err){platform.log('error',err);}
};
MultiZonePlatform.prototype.readCPUTemperature = function(){
  fs.readFile("/sys/class/thermal/thermal_zone0/temp", function (err, data) {
        if (err) {
          console.log("error", "cannot read CPU Temp", err);
        }else{
          platform.updateSensorData('CPU', { 'temp' : data/1000 }); 
          //platform.cpuTemp=data/1000;
          //platform.log("CPU Temp", platform.cpuTemp);
        }
      });
};
MultiZonePlatform.prototype.getZoneForDevice=function(deviceid){
  for(var zone in this.zones){
    if(this.zones[zone].sensors[deviceid])return zone;
  }
  return null;
};
MultiZonePlatform.prototype.updateSensorData = function(deviceid, data){
  //platform.log("updateSensorData",deviceid);
  var zone = this.getZoneForDevice(deviceid);
  if(!zone){
    for(var zone in this.zones){
      this.zones[zone][deviceid]=data;
      return;
    }
  }
  //platform.log("zone", zone," device", deviceid);
  // write the data on the zones object
  var timestamp=new Date().toString();
  for(var val in data){
    this.zones[zone].sensors[deviceid][val]=data[val];
    this.zones[zone].sensors[deviceid]['timestamp']=timestamp;
  }
  // set the characteristics
  var foundAccessories = 0;
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    for(var j in accessory.services){

      var service = accessory.services[j];
      if(service.displayName==deviceid || service.displayName=="Zone"+zone+" Thermostat" || service.displayName=="Zone"+zone+" ThermostatBatt" || service.displayName==deviceid+"Batt")
      {
        foundAccessories++;
        this.setCharacteristics(service,deviceid,data);
      }
    }
  }
  if(foundAccessories<4){
     this.addAccessoriesForSensor(deviceid);
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
MultiZonePlatform.prototype.getAverageSensor=function(zone,dataType){
  var count=0,sum=0;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(val){sum+=val;count++}
  }
  return count>0 ? Math.round(sum/count) : 0;
};
MultiZonePlatform.prototype.getMinimumSensor=function(zone,dataType){
  var min;
  for(var deviceid in this.zones[zone].sensors){
    var val=this.zones[zone].sensors[deviceid][dataType];
    if(!min || val<min){min=val;}
  }
  return min;
};
MultiZonePlatform.prototype.setCharacteristics = function(service,deviceid,data){
  //platform.log("setCharacteristics",deviceid);
  for(var dataType in data){
    //platform.log("dataType", dataType,"=",data[dataType]);
    //service.sensorData[deviceid][dataType]=data[dataType];
    switch(dataType){
      case 'temp':  
        if(this.testCharacteristic(service,Characteristic.CurrentTemperature))
        {
          if(service.displayName.indexOf("Thermostat")){
            var zone = this.getZoneForDevice(deviceid);
            service.setCharacteristic(Characteristic.CurrentTemperature,this.getAverageSensor(zone,dataType));
          }
          else 
            service.setCharacteristic(Characteristic.CurrentTemperature,Number(data[dataType]));
        }
        break;
      case 'batt':  
        if(this.testCharacteristic(service,Characteristic.BatteryLevel))
        {
          var val=(Number(data[dataType])-2)*100;
          if(service.displayName.indexOf("Thermostat")){
            var zone = this.getZoneForDevice(deviceid);
            val=(this.getMinimumSensor(zone,dataType)-2)*100;
          }
          service.setCharacteristic(Characteristic.BatteryLevel,val);
          service.setCharacteristic(Characteristic.StatusLowBattery,val<30);
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
MultiZonePlatform.prototype.addAccessoriesForSensor = function(deviceid){
  // no service was assigned this device
  // add all accessories and services needed and set characteristics
 
  //Get the Zone data for the device
  for(var zone in this.zones){
    var sensor=this.zones[zone].sensors[deviceid];
    if(sensor && sensor.source=='serial'){
      //create a temperature sensor
      this.addAccessory(deviceid);
    }
    if(sensor){
      //create a thermostat
      this.addAccessory("Zone"+zone+" Thermostat");
    }
  }
};
MultiZonePlatform.prototype.addAccessory = function(accessoryName) {
  // check we dont already have that one
  for(var i in this.accessories){
    if (this.accessories[i].displayName==accessoryName) {
      return;
    }
  }
  platform.log("TODO:when do I set defaults in add or configure?");
  platform.log("Add Accessory",accessoryName);
  var uuid = UUIDGen.generate(accessoryName);

  var accessory = new Accessory(accessoryName, uuid);
  accessory.on('identify', function(paired, callback) {
    platform.log(accessory.displayName, "Identify!!!");
    callback();
  });

  this.configureAccessory(accessory);
  var service=accessory.getService(Service.Thermostat);
  if(service){
    platform.log("set thermostat defaults")
    service.setCharacteristic(Characteristic.TargetTemperature, 21);
    service.setCharacteristic(Characteristic.TemperatureDisplayUnits, platform.temperatureDisplayUnits);
    service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  }
  this.api.registerPlatformAccessories("homebridge-multizone-thermostat", "MultiZonePlatform", [accessory]);
};
MultiZonePlatform.prototype.configureAccessory = function(accessory) {
  platform.log(accessory.displayName,"Configure Accessory");
  
  // add a Battery service
  //platform.log("add battery service to ", accessory.displayName);
  accessory.batteryService=accessory.getService(Service.BatteryService);
  if(accessory.batteryService==undefined){
    accessory.batteryService=accessory.addService(Service.BatteryService, accessory.displayName+"Batt");
  }
  accessory.batteryService.typename="BatteryService";
  accessory.batteryService.sensorData={};
      
  if(accessory.displayName.indexOf('Zone')>=0){
    this.makeThermostat(accessory);
  }else{
    this.makeTemperatureSensor(accessory);
  }
  
  accessory.reachable = true;
  this.accessories.push(accessory);
};
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
    platform.log("added TemperatureSensor");
  }
};
MultiZonePlatform.prototype.makeThermostat=function(accessory){
  //platform.log("makeThermostat",accessory.displayName);
  var zone=accessory.displayName.substr(accessory.displayName.indexOf("Zone")+4,1);
  
  accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "mcmspark")
      .setCharacteristic(Characteristic.Model, 'Zone Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, '00x000x0000x')
      .setCharacteristic(Characteristic.FirmwareRevision, '1');
    // add a Thermostat service
  accessory.thermostatService=accessory.getService(Service.Thermostat);
    if(accessory.thermostatService==undefined){
      accessory.thermostatService=accessory.addService(Service.Thermostat, accessory.displayName);
      platform.log("added ThermostatService");
    }
  
  for(var d in platform.zones[zone]["sensors"]){
    var sensor=platform.zones[zone]["sensors"][d];
    if(sensor['extras'].indexOf('press')>=0){
      // add AirPressure Characteristic
      // This causes a warning
      if(accessory.thermostatService.getCharacteristic(AirPressure)==undefined){
        accessory.thermostatService.addCharacteristic(AirPressure);
        platform.log("added AirPressure Characteristic");
      }
    }
  }
};
MultiZonePlatform.prototype.updateGPIO=function(zone,val){
  try{
    //platform.log("update pin", platform.zones[zone].relayPin, val);
    gpio.write(platform.zones[zone].relayPin,val);
  }catch(err){
    platform.log('error',JSON.stringify(err));
  }
};
MultiZonePlatform.prototype.systemStateName=function(heatingCoolingState) {
  if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.HEAT) {
    return 'Heat';
  } else if (heatingCoolingState === Characteristic.CurrentHeatingCoolingState.COOL) {
    return 'Cool';
  } else {
    return 'Off';
  }
};
MultiZonePlatform.prototype.getThermostatForZone=function(zone){
  for(var i in this.accessories){
    var accessory=this.accessories[i];
    var service=accessory.getService(Service.Thermostat);
    if(service && service.displayName=="Zone"+zone+" Thermostat")
    {
      //platform.log("Found", service.displayName,zone);
      return service
    }
  }
  platform.log("ERROR:  this should not be null", zone);
  return null;
};
MultiZonePlatform.prototype.currentlyRunning=function(service){
  return platform.systemStateName(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value);
};
MultiZonePlatform.prototype.shouldTurnOnHeating=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.HEAT && 
          currentTemp < targetTemperature);
};
MultiZonePlatform.prototype.shouldTurnOnCooling=function(targetState,currentTemp,targetTemperature){
  return (targetState === Characteristic.TargetHeatingCoolingState.COOL && 
          currentTemp > targetTemperature);
};
MultiZonePlatform.prototype.turnOnSystem=function(zone, service, systemToTurnOn) {
    if(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value === Characteristic.CurrentHeatingCoolingState.OFF){
      //platform.log("pre",service.preSensordata);
      platform.log("START",this.systemStateName(systemToTurnOn), service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
      //platform.log("sensorData",JSON.stringify(service.sensorData));
      furnaceLog.push({"zone":zone, "run":true, "timestamp":(new Date().toISOString())});
      platform.updateGPIO(zone, ON);
      service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, systemToTurnOn);
      this.lastCurrentHeatingCoolingStateChangeTime=new Date();
    } else if (service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value !== systemToTurnOn) {
      // if we want heat but it is cooling or vis versa
      this.turnOffSystem(zone, service);
    }
};
MultiZonePlatform.prototype.timeSinceLastHeatingCoolingStateChange=function(){
  return (new Date() - this.lastCurrentHeatingCoolingStateChangeTime);
};
MultiZonePlatform.prototype.turnOffSystem=function(zone, service){
  //platform.log("pre",service.preSensordata);
  platform.log("STOP",platform.currentlyRunning(service) , service.displayName, service.getCharacteristic(Characteristic.CurrentTemperature).value);
  //platform.log("sensorData",JSON.stringify(service.sensorData));
  furnaceLog.push({"zone":zone, "run":false, "timestamp":(new Date().toISOString())});
  platform.updateGPIO(zone, OFF);
  service.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
  this.lastCurrentHeatingCoolingStateChangeTime=new Date();
};  
MultiZonePlatform.prototype.updateSystem=function(){
  //platform.log("updating...",service.displayName, service.timeSinceLastHeatingCoolingStateChange() , service.minOnOffTime);  
  //if (service.timeSinceLastHeatingCoolingStateChange() < service.minOnOffTime) {
  //  var waitTime = service.minOnOffTime - service.timeSinceLastHeatingCoolingStateChange();
    //platform.log("INFO Need to wait",waitTime / 1000,"second(s) before state changes.",service.displayName);
  //  return;
  //}
  var changed=false;
  for(var zone in platform.zones){
    var service=platform.getThermostatForZone(zone);
    if(service){
      //platform.log("updateSystem",service.displayName);
      // read all values service.averageSensorValue('temp')
      var currentState=service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
      var targetState=service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value;
      var currentTemp=service.getCharacteristic(Characteristic.CurrentTemperature).value;
      var targetTemperature=service.getCharacteristic(Characteristic.TargetTemperature).value;
      //service.heatingThresholdTemperature=service.getCharacteristic(Characteristic.HeatingThresholdTemperature).value;
      //service.coolingThresholdTemperature=service.getCharacteristic(Characteristic.CoolingThresholdTemperature).value;
      
      //platform.log("Eval",currentState,targetState,currentTemp,targetTemperature,this.shouldTurnOnHeating(targetState,currentTemp,targetTemperature));

      if (currentState === Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
        //platform.log("it is currently off and it should not be");
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(service)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } 
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState === Characteristic.TargetHeatingCoolingState.OFF) {
            //platform.log("it is currenty not off and it should be");
            platform.turnOffSystem(zone,service);
      } else if (currentState !== Characteristic.CurrentHeatingCoolingState.OFF
          && targetState !== Characteristic.TargetHeatingCoolingState.OFF) {
            //platform.log("it is currently not off and it should be not off");
        if (platform.shouldTurnOnHeating(targetState,currentTemp,targetTemperature)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.HEAT);
        } else if (platform.shouldTurnOnCooling(service)) {
          platform.turnOnSystem(zone,service,Characteristic.CurrentHeatingCoolingState.COOL);
        } else {
          platform.turnOffSystem(zone,service);
        }
      } 
      if (platform.timeSinceLastHeatingCoolingStateChange() > platform.minOnOffTime*4) {
        //just sync up Hardware periodically 
        platform.updateGPIO(zone,currentState === Characteristic.CurrentHeatingCoolingState.HEAT ? ON : OFF);
        changed=true;
      }
    }
  }
  if(changed){
    platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
    //platform.log("reset timer");
  }
};
MultiZonePlatform.prototype.startControlLoop=function(){
  platform.lastCurrentHeatingCoolingStateChangeTime=new Date();
  platform.log("startControlLoop",platform.minOnOffTime);
  setTimeout(function(){
    for(var zone in platform.zones){
      var service=platform.getThermostatForZone(zone);
      if(service)
        platform.updateGPIO(zone,service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value === Characteristic.CurrentHeatingCoolingState.HEAT ? ON : OFF);
    }
  },10000);
  platform.updateInterval=setInterval(function(){platform.updateSystem();},platform.minOnOffTime);
};