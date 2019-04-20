# homebridge-multizone-thermostat
This project is a homebridge-plugin that allows a multi-zone furnace to be controlled from a central system.  This plugin acts like a platform and can be confgured to manage a system of temperature sensors and zoned thermostat controls.

In my current implementation I use the following hardware components:

Raspberry PI Zero W
Adafruit PITFT 3.5" touchscreen
SainSmart Relay board
USB Phone charger battery
24v AC to 5v DC converter

I have used 2 types of temperature sensors in the making of this control.
1) WirelessThings Slice of Radio
    Unfortunatly this company is out of business.  Similar systems do exist.  It provides a serial interface that collects and queues sensor readings from a sensor network on its own radio network.
2) 7 Temperature sensors
    These report every minute a temperature reading and every 5 minutes a battery level
3) BME-280
    This is an I2C device that collects Temperature Pressure and Humidity

# Instalation

Download and install raspbian Stretch (I used 2018-10-09-raspbian-stretch.img)
Set up localization, change password and setup wifi
do not update
reboot

rasps-config or gui version
SSH on - to remote into
SPI on - for the PITFT
I2C on - for the bme-280
Set serial to on but not login console - for the slice of radio
reboot

disconnect the HDMI monitor if you had one

setup the PITFT  https://learn.adafruit.com/adafruit-pitft-3-dot-5-touch-screen-for-raspberry-pi/easy-install-2
1) ssh into the pi and download the install script then run it
```
cd ~
chmod +x adafruit-pitft.sh
sudo ./adafruit-pitft.sh
```
choose options to match the PITFT (Mine was opt 4 and then 3)
wait (on a pi zero this takes  over a minute)
say n to the display cmd prompt
say y to the mirror hdmi

reboot
make sure the PITFT is working
if it is not then remote back in and choose y to cmd prompt
set the raps-config to boot to cmd line
or
changed in /usr/share/X11/xorg.conf.d/99-fbturbo.conf the fb dev to 1
Section "Device"
    Identifier      "Allwinner A10/A13 FBDEV"
    Driver          "fbturbo"
    Option          "fbdev" "/dev/fb1"
    Option          "SwapbuffersWait" "true"
EndSection

install node
```
sudo apt-get install -y nodejs libavahi-compat-libdnssd-dev npm
sudo npm install -g n
sudo n 8
```
install rpi-gpio
```
sudo npm install -g --unsafe-perm rpi-gpio
```
install serialport
```
sudo npm install -g --unsafe-perm serialport
```
install adafruit GPIO
```
sudo apt-get install build-essential python-pip python-dev python-smbus git
git clone https://github.com/adafruit/Adafruit_Python_GPIO.git
cd Adafruit_Python_GPIO
sudo python setup.py install
cd ..
```
install adafruit node
```
sudo npm --save -g install node-adafruit-bme280
```
modify the default address to 0x76
```
sudo nano /usr/local/lib/node_modules/node-adafruit-bme280/python/Adafruit_BME280.py
```
install BCM 2835 libraries so that the thermo will install
```
cd ~
wget http://www.airspayce.com/mikem/bcm2835/bcm2835-1.52.tar.gz
tar zxvf bcm2835-1.52.tar.gz
cd bcm2835-1.52
./configure && make && sudo make check && sudo make install
cd ..
```
install homebridge following homebridge  and https://github.com/mcmspark/homebridge-multizone-thermostat
```
sudo npm install -g --unsafe-perm homebridge homebridge-multizone-thermostat
```
install wemo
```
sudo npm install -g homebridge-platform-wemo
```

update the .homebridge/config.json
```
mkdir .homebridge
sudo nano ~/.homebridge/config.json
```
paste this and modify
```
{
    "bridge": {
	    "name": "Homebridge",
	    "username": "CC:22:3D:E3:CE:30",
	    "port": 51826,
	    "pin": "031-45-154"
    },
    "description": "",
    "accessories": [
    ],
    "platforms": [
	{
           "platform": "BelkinWeMo",
           "name": "WeMo Platform"
       },
            {
                "platform" : "MultiZonePlatform",
                "name" : "MultiZone Platform",
	       "zones" : {
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
                }
            }
    ]
}
```

Add homebridge to the startup
install pm2 as a process manager
```
npm install -g pm2
pm2 startup
```
  — folow the instructions to copy the command and run it
```
pm2 start homebridge
pm2 save
```
See it running
```
pm2 show homebridge
```
see the QR Code
```
head -47 /home/pi/.pm2/logs/homebridge-out.log
```

Add mimetype support for the webUI
```
sudo npm install -g mime
```
add serial port
```
sudo npm install -g serialport --unsafe-perm --build-from-source
```
following https://www.reddit.com/r/IOT/comments/567k13/slice_of_radio_by_wirelessthings_ciseco_setup/
and https://reversatronics.blogspot.com/2016/10/ciseco-slice-of-radio-srf-and-at.html


kill any service on the serial port
```
sudo systemctl mask serial-getty@ttyAMA0.service
```


Add pm2 restart every 6 hours to keep it from losing sync
create a file 
```
sudo nano /usr/local/lib/pm2_restart.js
```
put this in it…
```
var pm2 = require('pm2');
// restarts homebridge every hour
pm2.connect(function(err) {
  if (err) throw err;
  setTimeout(function worker() {
    console.log("Restarting homebridge...");
    pm2.restart('homebridge', function() {});
    setTimeout(worker, 60 * 60 * 1000 * 6);
    }, 60 * 60 * 1000 * 6);
});
```
```
pm2 start /usr/local/lib/pm2_restart.js
pm2 save
```
add a home start up
```
sudo nano /home/pi/.config/lxsession/LXDE-pi/autostart
```
add to the end @chromium-browser --kiosk http://localhost:3000/

just curious  the PITFT setup mentioned /boot/cmdline.txt - it said removing fbcon map from this file


QR CODE

```
awk '/Scan this code with your HomeKit app/,/DidFinishLaunching/' /home/pi/.pm2/logs/homebridge-out.log
```