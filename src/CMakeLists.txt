cmake_minimum_required(VERSION 3.16)

set(MOINK_SRCS
    "main.c" "epd_drv.c" "settings.c" "netif_ap.c" "captive.c"
    "ota_web.c" "frame.c" "power.c")

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

# MOINK_EMBED_PAGE=OFF 编译出不带内嵌页的 app；GET / 改发一个"请上传页面"的
# 占位页，完整页面需上传到 "web" 分区。这是「固件放不下」时的逃生通道，见 main.c。
option(MOINK_EMBED_PAGE "Embed the full web page into the app image" ON)
if(MOINK_EMBED_PAGE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE MOINK_EMBED_PAGE=1)
else()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE MOINK_EMBED_PAGE=0)
endif()
