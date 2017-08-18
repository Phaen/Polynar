//     Polynar.js 1.0
//     http://srv2.blobtech.nl/Polynar
//     (c) 2014 Pablo Kebees
//     Polynar may be freely distributed under the MIT license.

( function() {
	
	// the name of the Polynar object
	var objName = 'Polynar';
	
	// the Polynar object
	var obj = { modules: {} };
	
	// registering useful character sets
	obj.digit = '0123456789';
	obj.hex = obj.digit + 'ABCDEF';
	obj.lowalpha = 'abcdefghijklmnopqrstuvwxyz';
	obj.hialpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	obj.alpha = obj.lowalpha + obj.hialpha;
	obj.alphanumeric = obj.digit + obj.alpha;
	obj.printable = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
	obj.htmlSafe = ' !#$%\'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
	obj.Base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	obj.urlSafe = obj.alpha + obj.digit + '$-_.+!*\'()'; // http://www.ietf.org/rfc/rfc1738.txt
	
	// the default character set to use
	var defaultCharset = obj.Base64;
	
	// strict mode by default
	var defaultStrict = false;
	
	// the default base to encode integer parts under, 3 is on average the most efficient
	var defaultBase = 3;
	
	// the date shorthands
	var dates = [ 'second', 'minute', 'hour', 'day', 'week', 'month', 'year' ];
	var dateInts = [ 1000, 60, 60, 24, 7, 4.348214285714286, 12 ];
	
	// registering our object name, both browser and server side
	if( typeof exports == 'undefined' )
		this[ objName ] = obj;
	else {
		
		if ( typeof module !== 'undefined' && module.exports )
			exports = module.exports = obj;
		
		exports[ objName ] = obj;
		
	}
	
	// define our own is[Type] functions
	var isObject = function( o ) { return o && typeof o === 'object'; };
	var isArray = function( o ) { return o && o.constructor.name == 'Array'; };
	var isDate = function( o ) { return o && o.constructor.name == 'Date'; };
	
	// basic math functions
	var multiply = function( a, b ) { return a * b; };
	
	// validate encodingOptions
	var validateOptions = function( optionsObj ) {
		
		if( !isObject( optionsObj ) )
			throw TypeError( optionsObj + ' is not an object' );
		
		if( obj.modules[ optionsObj.type ] == 'undefined' )
			throw TypeError( 'Invalid encoding type' );
		
		// lets shallow copy the options so we may make any adjustments
		var options = {};
		for( var i in optionsObj )
		if( optionsObj.hasOwnProperty( i ) )
			options[ i ] = optionsObj[ i ];
		
		if( obj.modules[ options.type ].validator )
			obj.modules[ options.type ].validator.call( obj, options );
		
		if( typeof options.limit != 'undefined' )
			if( typeof options.limit != 'number' || options.limit % 1 != 0 || options.limit < 0 )
				throw TypeError( 'Invalid item limit' );
		
		return options;
		
	}
	
	// validate character set
	var validateCharset = function( charset ) {
		
		var errChar = 'Invalid character set', errBin = 'Invalid binary range';
		
		if( typeof charset == 'undefined' )
			charset = defaultCharset;
		else if( typeof charset == 'number' ) {
			
			if( charset % 1 != 0 || charset < 2 )
				throw TypeError( errBin );
			
			charset = [ 0, charset ];
			
		} else if( typeof charset == 'string' ) {
			
			if( charset.match( /(.).*\1/ ) )
				throw Error( errChar );
			
		} else if( isArray( charset ) ) {
			
			if( charset.length != 2 )
				throw TypeError( errBin );
			
			// swap bounds if wrong order
			if( charset[ 0 ] > charset[ 1 ] )
				charset.reverse();
			
			if( charset[ 1 ] - charset[ 0 ] < 2 )
				throw Error( errChar );
			
		} else
			throw TypeError( errChar );
		
		return charset;
		
	}
	
	// encoder class
	obj.encoder = function( strict ) {
		
		if( !this instanceof obj.encoder )
			return new obj.encoder( strict );
		
		if( typeof strict == 'undefined' )
			strict = defaultStrict;
			
		strict = Boolean( strict );
		
		this.strict = strict;
		this.radii = new Array();
		this.integers = new Array();
		
	}
	
	obj.encoder.prototype.write = function( items, options ) {
		
		options = validateOptions( options );
		
		if( !isArray( items ) )
			items = [ items ];
		
		if( typeof options.preProc == 'function' )
			for( var i in items )
				items[ i ] = options.preProc( items[ i ] );
		
		if( options.limit )
			if( items.length > options.limit )
				throw RangeError( 'Item count exceeds limit' );
			else
				this.compose( items.length, options.limit + 1 );
		
		obj.modules[ options.type ].encoder.call( this, items, options );
		
	}
	
	obj.encoder.prototype.compose = function( integer, radix ) {
		
		this.integers.push( integer );
		this.radii.push( radix );
		
	}
		
	obj.encoder.prototype.composeTerm = function( integer ) {
		
		while( integer != 0 ) {
			
			this.compose( integer % defaultBase + 1, defaultBase + 1 );
			integer = Math.floor( integer / defaultBase );
			
		}
		this.compose( 0, defaultBase + 1 );
		
	}
	
	obj.encoder.prototype.toString = function( charset ) {
		
		var binary = false;
		
		charset = validateCharset( charset );
		
		if( typeof charset == 'string' )
			var size = charset.length;
		else
			var size = charset[ 1 ] - charset[ 0 ] + 1;
		
		var radii = 1;
		var current = 0;
		
		var build = function( integer, radix ) {
			
			var left = Math.floor( size / radii );
			
			if( left < 2 ) {
				
				if( typeof charset == 'string' )
					str += charset.charAt( current );
				else
					str += String.fromCharCode( current + charset[ 0 ] );
				
				current = 0;
				radii = 1;
				left = size;
				
			}
			
			if( left >= radix ) {
				
				current += radii * integer;
				radii *= radix;
				
			} else {
				
				var factor = Math.ceil( radix / left );
				
				current += radii * Math.floor( integer / factor );
				radii *= left;
				
				build( integer % factor, factor );
				
			}
			
		}
		
		var str = '';
		for( var i in this.radii )
			build( this.integers[ i ], this.radii[ i ] );
		
		if( radii != 0 )
			if( typeof charset == 'string' )
				str += charset.charAt( current );
			else
				str += String.fromCharCode( current + charset[ 0 ] );
		
		return str;
		
	}
	
	// decoder class
	obj.decoder = function( str, charset, strict ) {
		
		if( !this instanceof obj.decoder )
			return new obj.decoder( str, charset, strict );
		
		if( typeof str == 'undefined' )
			throw Error( 'Missing first argument' );
		
		if( typeof strict == 'undefined' )
			strict = defaultStrict;
			
		strict = Boolean( strict );
		str = String( str );
		
		charset = validateCharset( charset );
		
		if( typeof charset == 'string' )
			this.size = charset.length;
		else
			this.size = charset[ 1 ] - charset[ 0 ] + 1;
		
		this.strict = strict;
		this.str = str;
		this.charset = charset;
		
	}
	
	obj.decoder.prototype.parse = function( radix ) {
		
		var left;
		
		if( typeof this.current == 'undefined' || ( left = Math.floor( this.size / this.radii ) ) == 1 ) {
			
			if( typeof this.current == 'undefined' )
				this.pointer = 0;
			else if( this.current != 0 )
				throw Error( 'Oversaturated byte at position ' + this.pointer );
			else
				this.pointer ++;
			
			this.radii = 1;
			left = this.size;
			
			if( this.pointer == this.str.length )
				throw new Error( 'Unexpected end of input while parsing' );
			
			if( typeof this.charset == 'string' ) {
				
				this.current = this.charset.indexOf( this.str.charAt( this.pointer ) );
				
				if( this.current == -1 )
					throw Error( 'Byte at ' + this.pointer + ' not found in character set' );
				
			} else {
				
				this.current = this.str.charCodeAt( this.pointer ) - this.charset[ 0 ];
				
				if( this.current > this.charset )
					throw Error( 'Byte at ' + this.pointer + ' does not fit binary range' );
				
			}
			
			
		}
		
		if( left >= radix ) {
			
			var integer = this.current % radix;
			this.current = Math.floor( this.current / radix );
			this.radii *= radix;
			
		} else {
			
			var factor = Math.ceil( radix / left );
			
			var integer = this.current * factor;
			this.current = Math.floor( this.current / left );
			this.radii *= left;
			
			integer += this.parse( factor );
			
		}
		
		return integer;

	}
	
	obj.decoder.prototype.parseTerm = function() {
		
		var integer = 0;
		var md = this.parse( defaultBase + 1 ) - 1;
		for( var pow = 0; md != -1; pow ++ ) {
			
			integer += md * Math.pow( defaultBase, pow );
			md = this.parse( defaultBase + 1 ) - 1;
			
		}
		
		return integer;
		
	}
		
	obj.decoder.prototype.read = function( options, count ) {
		
		var i, chr, size, len, ptr, item;
		
		if( typeof count == 'undefined' )
			var count = 1;
		
		if( typeof count != 'number' || count % 1 != 0 || count < 0 )
			if( this.strict )
				throw TypeError( 'Count must be positive integer' );
			else
				count = Math.max( 0, Math.floor( Number( count ) ) );
		
		options = validateOptions( options );
		
		if( options.limit )
			count = this.parse( options.limit + 1 );
		
		var items = obj.modules[ options.type ].decoder.call( this, options, count );
		
		if( typeof options.postProc == 'function' )
			for( i in items )
				items[ i ] = options.postProc( items[ i ] );
				
		if( count == 1 )
			items = items.pop();
		
		return items;
		
	}
	
	// Polynar expansion
	
	obj.module = function( name, validator, encoder, decoder ) {
		
		this.modules[ name ] = { 'validator': validator, 'encoder': encoder, 'decoder': decoder };
		
	}
	
	// modules
	
	obj.module(
		'number',
		function( options ) {
			
			// 1 step by default
			if( typeof options.step == 'undefined' )
				options.step = 1;
			else if( typeof options.step != 'number' || options.step < 0 )
				throw TypeError( 'Invalid step size' );
			
			// max and min defaults
			if( typeof options.min == 'undefined' )
				options.min = 0;
			if( typeof options.max == 'undefined' )
				options.max = 0;
			
			// both bounds must be integer
			if(
				( typeof options.min != 'number' && typeof options.min != 'boolean' && options.min !== false ) ||
				( typeof options.max != 'number' && typeof options.max != 'boolean' && options.max !== false )
			)
				throw TypeError( 'Invalid range bound' );
			
			if( options.max != false && options.min != false ) {
				
				// swap bounds if wrong order
				if( options.min > options.max )
					options.min = options.max + ( options.max = options.min, 0 );
				
				if( ( options.max - options.min ) / options.step % 1 > 0.0000000000000001 ) // fucking floats
					throw TypeError( 'Range bound outside step range' );
				
			}
			
		},
		function( items, options ) {
			
			for( var i in items ) {
				
				item = items[ i ];
				
				if( typeof item != 'number' )
					if( this.strict )
						throw TypeError( 'Item \'' + item + '\' not a number' );
					else
						item = Number( item ) || 0; // cast it to number or settle for 0 if NaN
				
				if( options.max === false || options.min === false ) {
					
					sign = 0;
					
					if( options.min === false && options.min === false ) {
						if( item < 0 )
							sign ++;
						item = Math.abs( item );
					} else if( options.min === false )
						item = -1 * item + options.max;
					else
						item -= options.min;
					
					if( this.strict === false )
						item = Math.max( 0, item ); // limit to bound
					else if( item < 0 )
						throw RangeError( 'Item \'' + item + '\' exceeds range bounds' );
					
					item /= options.step;
					
					if( this.strict && item % 1 > 0.0000000000000001 ) // fucking floats
						throw RangeError( 'Item \'' + items[ i ] + '\' outside step range' );
					
					this.composeTerm( Math.floor( item ) );
					
					if( options.min === false && options.min === false )
						this.compose( sign, 2 );
					
					
				} else {
					
					if( this.strict === false )
						item = Math.min( options.max, Math.max( options.min, item ) ); // limit to bounds
					else if( item < options.min || item > options.max )
						throw RangeError( 'Item \'' + item + '\' exceeds range bounds' );
					
					item = ( item - options.min ) / options.step;
					
					if( this.strict && item % 1 > 0.0000000000000001 ) // fucking floats
						throw RangeError( 'Item \'' + items[ i ] + '\' outside step range' );
					
					this.compose( Math.floor( item ), ( options.max - options.min ) / options.step + 1 );
					
				}
				
			}
		},
		function( options, count ) {
			var items = new Array();
			if( options.max === false || options.min === false ) {
				
				for( i = 0; i < count; i++ ) {
					
					item = this.parseTerm();
					
					item *= options.step;
					
					if( options.max === false && options.min === false ) {
						if( this.parse( 2 ) )
							item *= -1;
					} else if( options.max === false )
						item += options.min;
					else
						item = -1 * item - options.max;
					
					items.push( item );
					
				}
				
			} else
				for( i = 0; i < count; i++ )
					items.push( this.parse( ( options.max - options.min ) / options.step + 1 ) * options.step + options.min );
			
			return items;
		}
	);
	
	obj.module(
		'string',
		function( options ) {
			
			if( typeof options.max == 'undefined' )
				options.max = false;
			
			if(
				( typeof options.max != 'number' || options.max % 1 != 0 || options.max < 0 ) &&
				( typeof options.max != 'boolean' || options.max !== false )
				
			)
				throw TypeError( 'Invalid string limit' );
			
			if( typeof options.charset == 'undefined' )
				options.charset = obj.printable;
			else
				options.charset = validateCharset( options.charset );
			
		},
		function( items, options ) {
			
			if( typeof options.charset != 'string' )
				size = options.charset[ 1 ] - options.charset[ 0 ] + 1;
			
			for( i in items ) {
				
				item = items[ i ];
				
				if( typeof item != 'string' )
					if( this.strict )
						throw TypeError( 'Item \'' + item + '\' not string' );
					else
						item = String( item );
				
				if( options.max === false )
					this.composeTerm( item.length );
				else {
					
					if( item.length > options.max )
						if( this.strict )
							throw RangeError( 'Item \'' + item + '\' exceeds max length' );
						else
							item = item.substr( 0, options.max ); // cut off at max length
					
					this.compose( item.length, options.max + 1 );
					
				}
				
				for( chr = 0; chr < item.length; chr ++ )
					if( typeof options.charset == 'string' ) {
						
						pos = options.charset.indexOf( item.charAt( chr ) );
						
						if( pos == -1 )
							throw Error( 'String not compliant with character set' );
						
						this.compose( pos, options.charset.length );
						
					} else {
						
						pos = item.charCodeAt( chr );
						
						if( pos < options.charset[ 0 ] || pos > options.charset[ 1 ] )
							throw Error( 'String not compliant with character set' );
						
						this.compose( pos - options.charset[ 0 ], size );
						
					}
				
			}
			
		},
		function( options, count ) {
			
			var i, len, chr, item, items = new Array();
			if( typeof options.charset != 'string' )
				size = options.charset[ 1 ] - options.charset[ 0 ] + 1;
			
			for( i = 0; i < count; i++ ) {
				
				if( options.max === false )
					len = this.parseTerm();
				else
					len = this.parse( options.max + 1 );

				item = '';
				
				for( chr = 0; chr < len; chr ++ )
					if( typeof options.charset == 'string' )
						item += options.charset.charAt( this.parse( options.charset.length ) );
					else
						item += this.parse( size ) + options.charset[ 0 ];
				
				items.push( item );
				
			}
			
			return items;
			
		}
	);
	
	obj.module(
		'item',
		function( options ) {
			if(
				typeof options.list == 'undefined' ||
				!isArray( options.list ) ||
				options.list.length == 0
			)
				throw TypeError( 'Invalid or empty list' );
			
			if( typeof options.sort == 'bool' && options.sort === true )
				options.list = options.list.slice( 0 ).sort(); // slice, so we don't alter the original array
			
		},
		function( items, options ) {
			for( i in items ) {
				
				pos = options.list.indexOf( items[ i ] );
				
				if( pos == -1 )
					if( strict )
						throw Error( 'Item \'' + items[ i ] + '\' not found in list' );
					else
						pos = 0;
				
				this.compose( pos, options.list.length );
				
			}
		},
		function( options, count ) {
			var items = new Array();
			for( i = 0; i < count; i++ )
				items.push( options.list[ this.parse( options.list.length ) ] );
			return items;
		}
	);
	
	obj.module(
		'boolean',
		false,
		function( items, options ) {
			for( i in items ) {
				
				item = items[ i ];
				
				if( typeof item != 'boolean' )
					if( this.strict )
						throw TypeError( 'Item \'' + item + '\' not boolean' );
					else
						item = Boolean( item );
				
				this.compose( +item, 2 );
				
			}
		},
		function( options, count ) {
			var items = new Array();
			for( i = 0; i < count; i++ )
				items.push( Boolean( this.parse( 2 ) ) );
			return items;
		}
	);
	
	obj.module(
		'fraction',
		function( options ) {
			if( typeof options.precision == 'undefined' )
				options.precision = 1.0E-15;
			else if( typeof options.precision != 'number' || options.precision < 0 )
				throw TypeError( 'Invalid fraction precision' );
		},
		function( items, options ) {
			
			var i, item, a, h1, k1, h, k;
			for( i in items ) {
				
				item = items[ i ];
				
				if( typeof item != 'number' )
					if( this.strict )
						throw TypeError( 'Item \'' + item + '\' not a number' );
					else
						item = Number( item ) || 0; // cast it to number or settle for 0 if NaN
				
				a = Math.floor( item );
				h1 = 1;
				k1 = 0;
				h = a;
				k = 1;
				
				while( item - a > options.precision * k * k ) {
					item = 1 / ( item - a );
					a = Math.floor( item );
					h2 = h1; h1 = h;
					k2 = k1; k1 = k;
					h = h2 + a * h1;
					k = k2 + a * k1;
				}
				
				this.compose( +( h < 0 ), 2 );
				this.composeTerm( Math.abs( h ) );
				this.composeTerm( k - 1 );
				
			}
			
		},
		function( options, count ) {
			
			var items = new Array();
			for( i = 0; i < count; i++ )
				items.push( ( this.parse( 2 ) ? -1 : 1 ) * this.parseTerm() / ( this.parseTerm() + 1 ) );
			return items;
			
		}
	);
		
	obj.module(
		'any',
		false,
		function( items, options ) {
			
			for( var i in items ) {
				
				item = items[ i ];
				
				switch( typeof item ) {
					
					case 'undefined':
						this.compose( 0, 6 );
						break;
					
					case 'number':
						this.compose( 1, 6 );
						this.write( item, { type: 'fraction' } );
						break;
						
					case 'string':
						this.compose( 2, 6 );
						this.write( item, { type: 'string' } );
						break;
						
					case 'boolean':
						this.compose( 3, 6 );
						this.write( item, { type: 'boolean' } );
						break;
						
					case 'object':
						if( isDate( item ) ) {
							this.compose( 4, 6 );
							this.write( item, { type: 'date' } );
						} else {
							this.compose( 5, 6 );
							this.write( item, { type: 'object' } );
						}
						break;
					
					default:
						throw TypeError( 'Type \'' + typeof item + '\' not supported' );
					
				}
				
			}
		},
		function( options, count ) {
			
			var i, items = new Array();
			for( i = 0; i < count; i++ )
				switch( this.parse( 6 ) ) {
					
					case 0:
						items.push( undefined );
						break;
					
					case 1:
						items.push( this.read( { type: 'fraction' } ) );
						break;
						
					case 2:
						items.push( this.read( { type: 'string' } ) );
						break;
						
					case 3:
						items.push( this.read( { type: 'boolean' } ) );
						break;
						
					case 4:
						items.push( this.read( { type: 'date' } ) );
						break;
						
					case 5:
						items.push( this.read( { type: 'object' } ) );
					
				}
			return items;
			
		}
	);
			
	obj.module(
		'date',
		function( options ) {
			if( typeof options.interval == 'undefined' )
				options.interval = 1;
			else if(  typeof options.interval != 'number' || options.interval % 1 != 0 )
				if( typeof options.interval == 'string' && ( options.interval = dates.indexOf( options.interval ) ) != -1 )
					options.interval = dateInts.slice( 0, options.interval + 1 ).reduce( multiply );
				else
					throw TypeError( 'Invalid date interval' );
				
			if( isDate( options.min ) )
				options.min = options.min.getTime();
			
			if( isDate( options.max ) )
				options.max = options.max.getTime();
			
			if(
				( typeof options.min != 'undefined' && ( typeof options.min != 'number' || options.min % 1 != 0 ) ) ||
				( typeof options.max != 'undefined' && ( typeof options.max != 'number' || options.max % 1 != 0 ) )
			)
				throw TypeError( 'Invalid range bound' );
		},
		function( items, options ) {
		
			var i, item;
			for( i in items ) {
				
				item = items[ i ];
				
				if( typeof item == 'string' )
					item = Date.parse( item );
				
				if( !isDate( item ) || isNaN( item.getTime() ) )
					if( this.strict )
						throw TypeError( 'Item \'' + item + '\' not a valid date' );
					else
						item = new Date( item );
				
				item = item.getTime();
				
				this.write( Math.floor( item / options.interval ), { type: 'number', min: options.min || false, max: options.max || false, step: 1 } );
				
			}
		},
		function( options, count ) {
			
			var i, items = new Array();
			for( i = 0; i < count; i++ )
				items.push( new Date( this.read( { type: 'number', min: options.min || false, max: options.max || false, step: options.interval } ) * options.interval ) );
			return items;
			
		}
	);
	
	obj.module(
		'object',
		function( options ) {
		if( typeof options.template == 'undefined' )
			options.template = false;
		
		if(
			( typeof options.template != 'boolean' || options.template !== false ) &&
			!isObject( options.template )
		)
			throw TypeError( 'Invalid object template' );
		
		if(
			typeof options.base != 'undefined' &&
			!isArray( options.base ) &&
			!isObject( options.base ) &&
			typeof options.base != 'function'
		)
			throw TypeError( 'Invalid object base' );
		

		},
		function( items, options ) {
			
			var workTpl = function( obj, tpl ) {
				
				var key, keys = Object.keys( tpl === false ? obj : tpl );
				
				if( options.sort )
					keys.sort();
				
				if( tpl === false )
					this.composeTerm( keys.length );
				
				for( var k in keys ) {
					
					key = keys[ k ];
					
					if( tpl === false ) {
						
						this.write( key, { type: 'string' } );
						this.write( obj[ key ], { type: 'any' } );
						
					} else {
						
						if( typeof tpl[ key ].optional == 'undefined' )
							optional = options.optional
						else
							optional = tpl[ key ].optional;
						
						if( typeof obj[ key ] == 'undefined' )
							if( optional ) {
								this.compose( 0, 2 );
								continue;
							} else
								throw ReferenceError( 'Object has no property \'' + key + '\'' );
						
						if( optional )
							this.compose( 1, 2 );
						if( typeof tpl[ key ].type == 'string' )
							this.write( obj[ key ], tpl[ key ] );
						else if( isObject( tpl[ key ] ) )
							workTpl.call( this, obj[ key ], tpl[ key ] );
						else
							throw TypeError( 'Invalid object template' );
						
					}
					
				}
				
			}
			
			for( var i in items )
				workTpl.call( this, items[ i ], options.template );
			
		},
		function( options, count ) {
			
			var items = new Array();
			
			if( isArray( options.base ) && options.base.length != count )
				throw Error( 'Items and base count mismatch' );
			
			var workTpl = function( obj, tpl ) {
				
				var k, key, keys;
				
				if( tpl === false ) {
					
					keys = this.parseTerm();
					for( key = 0; key < keys; key ++ )
						obj[ this.read( { type: 'string' } ) ] = this.read( { type: 'any' } );
					
				} else {
					
					keys = Object.keys( tpl );
					
					if( options.sort )
						keys.sort();

					for( k in keys ) {
						
						key = keys[ k ];
						
						if( ( typeof tpl[ key ].optional == 'undefined' ? options.optional : tpl[ key ].optional ) && this.parse( 2 ) == 0 )
							continue;
						
						if( typeof tpl[ key ].type == 'string' )
							obj[ key ] = this.read( tpl[ key ] );
						else if( isObject( tpl[ key ] ) ) {
							
							if( typeof obj[ key ] == 'undefined' )
								obj[ key ] = {};
							
							workTpl.call( this, obj[ key ], tpl[ key ] );
							
						} else
							throw TypeError( 'Invalid object template' );
						
					}
					
				}
				
			}
			
			for( var i = 0; i < count; i++ ) {
				
				if( typeof options.base == 'undefined' )
					base = {};
				else if( isArray( options.base ) )
					base = options.base[ i ];
				else if( typeof options.base == 'function' )
					if( options.base.name = '' )
						base = options.base();
					else
						base = new options.base();
				else
					base = options.base;
				
				if( typeof base != 'object' )
					throw TypeError( 'Invalid object base' );
				
				workTpl.call( this, base, options.template )
				items.push( base );
				
			}
			
			return items;
			
		}
	);
	
} ).call( this );
