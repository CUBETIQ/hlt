JSON_FLAGS="{\"version\": \"$(shell git describe --tags --always --dirty)\", \"build_time\": \"$(shell date +%Y-%m-%d:%H:%M:%S)\", \"commit\": \"$(shell git rev-parse HEAD)\"}"

DOCKER_IMAGE=registry1.ctdn.net/cubetiq/http-tunnel-server

all: docker docker-arm

docker:
	docker build --build-arg JSON_FLAGS=$(JSON_FLAGS) -t $(DOCKER_IMAGE):latest .
	docker push $(DOCKER_IMAGE):latest

docker-arm:
	docker buildx build --build-arg JSON_FLAGS=$(JSON_FLAGS) -t $(DOCKER_IMAGE):arm . -f Dockerfile --platform linux/arm64 --push

build-flags:
	@echo $(JSON_FLAGS) > build.json

build:
	npm run build && make build-flags

dev:
	npm run start

docker-run:
	docker run --rm -it -p 3000:3000 --name http-tunnel-server-dev $(DOCKER_IMAGE):latest
