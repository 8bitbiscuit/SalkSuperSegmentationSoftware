# Local development. See README.md.
.PHONY: install serve dev build test test-desktop

install:            ## Ruby gems for Jekyll (kept in site/vendor), npm packages for the Worker
	cd site && bundle config set --local path vendor/bundle && bundle install
	cd worker && npm ci

serve:              ## The Jekyll site alone: http://localhost:4000
	cd site && bundle exec jekyll serve --livereload

dev:                ## Site + session API with a pretend cloud: http://localhost:8787
	./scripts/dev.sh

build:              ## site/_site, what gets deployed
	cd site && bundle exec jekyll build

test:               ## Worker unit tests and type-check
	cd worker && npm test && npx tsc

test-desktop:       ## napari script and watchdog (needs desktop/requirements.txt and pytest)
	python3 -m pytest desktop/tests
