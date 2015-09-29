#! /usr/bin/env node
var cli = require('cli');
var fs = require('fs');
var http = require('https');
var readline = require('readline-sync');
var chalk = require('chalk');
var playmusic = new (require('playmusic'))();
var mplayer = require('child_process').spawn;
var os = require('os');
var m3u = require('m3u');
var Q = require('q');
var _ = require('lodash');
var mkdirp = require('mkdirp');
var path = require('path');

var resultTypes = {
  track: '1',
  album: '3'
};

var filters = {
  onlyAlbums: function (entry) {
    return entry.type === resultTypes.album;
  },

  onlyTracks: function (entry) {
    return entry.type === resultTypes.track;
  }
};

cli.parse({
  song: ['s', 'The song you want to download/play.'],
  album: ['a', 'The album you want to download/play.'],
  'album-shuffle': ['A', 'Shuffle through albums in your library'],
  downloadonly: ['d', 'If you only want to download the song instead of playing it'],
  // offline: ['o', 'If you want to listen to already downloaded songs']
});

cli.main(function (args, options) {
  settings();

  if (options.song) {
    lookup(args.join(' '))
      .then(download)
      .then(play);
  }

  if (options.album) {
    lookupAlbum(args.join(' '))
      .then(downloadAlbum)
      .then(playAlbum);
  }

  if (options['album-shuffle']) {
    fetchAlbums()
      .then(_.shuffle)
      .then(playEachAlbum)
  }
  // else if (options.offline) {
  //   offline();
  // }
});

function fetchAlbums () {
  var deferred = Q.defer();

  playmusic.init({email: settings().email, password: settings().password}, function (err) {
    if (err) {
      console.warn(err);
      deferred.reject(err);
      return;
    }

    playmusic.getLibrary(function (err, tracks) {
      var albums = _.uniq(
        tracks.data.items
          .filter(track => 'albumId' in track)
          .map(track => ({albumId: track.albumId}))
      );

      deferred.resolve(albums);
    });
  });

  return deferred.promise;
}

function playEachAlbum (albums) {
  albums.reduce((promise, albumToPlay) => {
    return promise.then(() => downloadAlbum(albumToPlay)).then(playAlbum);
  }, Q());
}

function search (query, resultsFilter) {
  var deferred = Q.defer();

  playmusic.init({email: settings().email, password: settings().password}, function (err) {
    if (err) {
      console.warn(err);
      deferred.reject(err);
      return;
    }

    playmusic.search(query, 20, function (err, results) {
      if (err) {
        cli.error(err);
        cli.spinner('', true);
        return deferred.reject(err);
      }

      if (!results.entries) {
        cli.spinner('', true);
        cli.error('No songs/albums were found with your query, please try again!');
        return deferred.reject(err);
      }
      return deferred.resolve(results.entries.filter(resultsFilter));
    });
  });

  return deferred.promise;
}

function lookup (query) {
  var deferred = Q.defer();

  cli.spinner('Looking up requested song');

  search(query, filters.onlyTracks).then(function (results) {
    process.stdout.write('\n');

    results.forEach(function (entry, index) {
      console.log(chalk.yellow('[') + index + chalk.yellow('] ') + chalk.white(entry.track.title) + ' - ' + chalk.grey(entry.track.artist));
    });

    var input = readline.questionInt('What song do you want to play? #');
    cli.spinner('', true);

    deferred.resolve(results[input].track);
  });

  return deferred.promise;
}

function lookupAlbum (query) {
  var deferred = Q.defer();

  cli.spinner('Looking up requested album');

  search(query, filters.onlyAlbums).then(function (results) {
    process.stdout.write('\n');

    results.forEach(function (entry, index) {
      console.log(chalk.yellow('[') + index + chalk.yellow('] ') + chalk.white(entry.album.name) + ' - ' + chalk.grey(entry.album.artist));
    });

    var input = readline.questionInt('What album do you want to play? #');
    cli.spinner('', true);

    deferred.resolve(results[input].album);
  });

  return deferred.promise;
}

function settings() {
  if (!fs.existsSync(getLocation('settings'))) {
    var settings = {
      'email': 'add_your_email_here',
      'password': 'add_your_password_here'
    };

    fs.writeFileSync(getLocation('settings'), JSON.stringify(settings));
    cli.fatal('Go to ~/.gmplayerrc and add your email and password');
  }
  else {
    var settings = JSON.parse(fs.readFileSync(getLocation('settings')));
    if (settings.email == 'add_your_email_here') cli.fatal('Go to ~/.gmplayerrc and add your email and password');
    else return settings;
  }
}

function mplayerArgs (filename, isPlaylist) {
  var audioEngines = {
    linux: 'alsa',
    darwin: 'coreaudio'
  }

  var audioEngine = audioEngines[os.platform()];

  if (isPlaylist) {
    return ['-ao', audioEngine, '-playlist', filename];
  }

  return ['-ao', audioEngine, filename];
}

function playAlbum (playlistFile) {
  return play(playlistFile, true);
}

function play(file, playlist) {
  var deferred = Q.defer();
  playlist = !!playlist; // default to false

  var player = mplayer('mplayer', mplayerArgs(file, playlist));
  var isfiltered = false;

  console.log('Playing ' + path.basename(file) + '\n');

  player.stdout.on('data', function (data) {
    if (data.toString().substr(0,2) == 'A:' && !isfiltered) {
      player.stdout.pipe(process.stdout);
      isfiltered = true;
    }
  });

  // FIXME: In order for the input piping to mplayer to work I need to require this.
  require('readline').createInterface({input : process.stdin, output : process.stdout});
  process.stdin.pipe(player.stdin);

  player.on('error', function (data) {
    cli.fatal('There was an error playing your song, maybe you need to install mplayer?');
  });

  player.on('exit', deferred.resolve.bind(deferred));

  return deferred.promise;
}

function download (track) {
  var deferred = Q.defer();
  var songPath = getTrackPath(track);
  var songDirectory = getTrackDirectory(track);

  if (fs.existsSync(songPath)) {
    console.log('Song already found in offline storage, playing that instead.');
    deferred.resolve(songPath);

    return deferred.promise;
  }

  playmusic.getStreamUrl(track.nid, function (err, url) {
    if (err) {
      cli.error(err);
      deferred.reject(err);
      return;
    }

    mkdirp(songDirectory, function (err) {
      if (err) cli.error(err);

      http.get(url, function (res) {
        res.on('data', function (data) {
          if (!fs.existsSync(songPath)) {
            fs.writeFileSync(songPath, data);
          } else {
            fs.appendFileSync(songPath, data);
          }
        });

        res.on('end', function () {
          deferred.resolve(songPath);
        });
      });
    })
  });

  return deferred.promise;
}

function downloadAlbum (album) {
  var deferred = Q.defer();
  var m3uWriter = m3u.extendedWriter();

  playmusic.getAlbum(album.albumId, true, function (err, fullAlbumDetails) {
    if (err) {
      console.warn(err);
      deferred.reject(err);
      return;
    }

    cli.spinner('Downloading ' + fullAlbumDetails.artist + ' - ' + fullAlbumDetails.name);

    var downloadPromises = fullAlbumDetails.tracks.map(function (track) {
      m3uWriter.file(getTrackFilename(track));
      return download(track);
    });

    Q.all(downloadPromises).then(function () {
      cli.spinner('', true);
      return writePlaylist(m3uWriter, fullAlbumDetails);
    }).then(deferred.resolve);
  });

  return deferred.promise;
}

function writePlaylist (writer, album) {
  var playlistPath = path.join(
    getAlbumDirectory(album),
    sanitizeFilename(album.artist + ' - ' + album.name + '.m3u')
  );

  fs.writeFileSync(playlistPath, writer.toString());

  return playlistPath;
}

function getLocation(type) {
  switch (type) {
    case 'settings':
      return process.env['HOME'] + '/.gmplayerrc';
    break;
    case 'music':
      return process.env['HOME'] + '/Music/gmplayer';
    break;
  }
}

function getTrackFilename (track) {
  return sanitizeFilename(track.title + '.mp3');
}

function getAlbumDirectory (album) {
  return path.join(
    getLocation('music'),
    sanitizeFilename(album.artist),
    sanitizeFilename(album.name)
  );
}

function getTrackDirectory (track) {
  return path.join(
    getLocation('music'),
    sanitizeFilename(track.artist),
    sanitizeFilename(track.album)
  );
}

function getTrackPath (track) {
  return path.join(
    getTrackDirectory(track),
    getTrackFilename(track)
  );
}

function sanitizeFilename (filename) {
  return filename.replace(/\//g, '|');
}
