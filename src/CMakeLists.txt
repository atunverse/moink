cmake_minimum_required(VERSION 3.16)

set(MOINK_SRCS
    "main.c" "epd_drv.c" "settings.c" "netif_ap.c" "captive.c"
    "ota_web.c" "frame.c" "power.c" "store.c")

idf_component_register(
    SRCS ${MOINK_SRCS}
    INCLUDE_DIRS "."
    PRIV_REQUIRES driver nvs_flash esp_wifi esp_netif esp_event
                  esp_http_server esp_adc esp_hw_support
                  app_update spi_flash esp_partition esp_timer lwip
)

# PIO 的 ESP-IDF 集成不记录对生成头/版本头的隐式依赖（改了链接仍用旧内容），
# 故显式声明：改页必触发 main.c 重编；改版本号必触发全部源文件重编。
set_property(SOURCE main.c APPEND PROPERTY OBJECT_DEPENDS
             "${CMAKE_CURRENT_SOURCE_DIR}/index_html.h")
set_property(SOURCE ${MOINK_SRCS} APPEND PROPERTY OBJECT_DEPENDS
             "${CMAKE_CURRENT_SOURCE_DIR}/version.h")

# R1.2.0（FB-015）：控制页一律内嵌（唯一真源 = page/index.html），
# 原有的 MOINK_EMBED_PAGE 逃生开关与占位页已删除 —— 设备必须自带控制页，
# 否则首次连接无页面可用；「固件放不下」也早有实际余量（app 仅占槽位 6 成）。
