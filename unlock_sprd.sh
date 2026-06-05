#!/bin/bash

adb reboot bootloader
fastboot oem unlock_enable
fastboot oem cali_enable
number=`./fastboot oem get_identifier_token 2>&1 | grep "bootloader" | tail -n +2 | awk -F ' ' '{print $2}'`
echo "number:$number"
./signidentifier_unlockbootloader.sh $number rsa4096_vbmeta.pem sign.bin
./fastboot flashing unlock_bootloader sign.bin
./fastboot reboot
adb wait-for-device
adb root
adb disable-verity
adb reboot
